/* Camera & media capture for the admin panel.
 * Requires a secure context (HTTPS or localhost) to access the camera/mic.
 */

const MediaCapture = (() => {
  let stream = null;
  let recorder = null;
  let chunks = [];
  let captureMode = null;
  let startTime = 0;
  let tickTimer = null;

  // Build the modal markup once and append it to the body
  function buildUI() {
    if (document.getElementById('media-modal')) return;

    const wrap = document.createElement('div');
    wrap.id = 'media-modal';
    wrap.className = 'overlay';
    wrap.innerHTML = `
      <div class="glass-panel media-card">
        <div class="modal-header">
          <div class="modal-title-wrapper">
            <h3 id="media-modal-title"><i class="fa-solid fa-camera text-green"></i> Capturar multimedia</h3>
          </div>
          <button type="button" class="btn btn-close" id="media-close" aria-label="Cerrar">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>

        <div class="media-stage">
          <video id="media-video" class="media-video" autoplay playsinline muted></video>
          <canvas id="media-canvas" class="media-canvas hide"></canvas>
          <div id="media-placeholder" class="media-placeholder">
            <i class="fa-solid fa-camera-retro"></i>
            <p id="media-placeholder-text">Presiona el botón para iniciar la cámara</p>
          </div>
          <div id="media-rec-indicator" class="media-rec-indicator hide">
            <span class="media-rec-dot"></span> <span id="media-rec-time">00:00</span>
          </div>
        </div>

        <div id="media-preview" class="media-preview hide"></div>

        <div class="media-controls">
          <div class="media-mode-tabs">
            <button type="button" class="media-mode-btn active" data-mode="photo">
              <i class="fa-solid fa-camera"></i> Foto
            </button>
            <button type="button" class="media-mode-btn" data-mode="video">
              <i class="fa-solid fa-video"></i> Video
            </button>
          </div>

          <div class="media-actions">
            <button type="button" class="btn" id="media-file-btn">
              <i class="fa-solid fa-folder-open"></i> Subir archivo
            </button>
            <button type="button" class="btn btn-gradient" id="media-capture-btn">
              <i class="fa-solid fa-circle"></i> <span id="media-capture-label">Capturar</span>
            </button>
          </div>
        </div>

        <p class="media-hint text-muted">
          Si el navegador pide permiso, acéptalo. En celular se abrirá la cámara trasera del teléfono;
          en computadora se usa la cámara disponible.
        </p>
      </div>
    `;
    document.body.appendChild(wrap);
  }

  function wire() {
    buildUI();

    document.getElementById('media-close').addEventListener('click', close);
    document.getElementById('media-capture-btn').addEventListener('click', onCaptureClick);
    document.getElementById('media-file-btn').addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*,video/*';
      input.addEventListener('change', () => {
        if (input.files && input.files[0]) onFileReady(input.files[0]);
      });
      input.click();
    });

    document.querySelectorAll('.media-mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.media-mode-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        captureMode = btn.dataset.mode;
        resetPreview();
        stopStream();
        const placeholder = document.getElementById('media-placeholder');
        placeholder.classList.remove('hide');
        document.getElementById('media-placeholder-text').textContent = 'Iniciando cámara...';
        document.getElementById('media-video').classList.add('hide');
        const labels = { photo: 'Tomar foto', video: 'Grabar video' };
        document.getElementById('media-capture-label').textContent = labels[captureMode];
        const capBtn = document.getElementById('media-capture-btn');
        capBtn.classList.remove('recording');
        capBtn.querySelector('i').className = 'fa-solid fa-circle';

        startStream().then(() => onStreamReady()).catch((err) => {
          placeholder.classList.remove('hide');
          document.getElementById('media-placeholder-text').textContent = err.message;
        });
      });
    });

    // Stop the camera when the modal is dismissed with the backdrop
    document.getElementById('media-modal').addEventListener('click', (e) => {
      if (e.target.id === 'media-modal') close();
    });
}

// Labels browsers use for the rear camera across vendors.
const REAR_CAMERA_PATTERN = /(back|rear|trasera|environment)/i;

/**
 * Ask for the rear camera only.
 *
 * facingMode is unreliable: some phones ignore `ideal` and silently hand back
 * the front camera, and `exact` throws OverconstrainedError on devices that
 * only expose one camera. Enumerating devices and matching on the label is
 * the approach that behaves the same across phones.
 */
async function getRearCameraConstraints(wantAudio) {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras = devices.filter((d) => d.kind === 'videoinput');

  // Labels are only populated after permission has been granted at least once.
  const named = cameras.filter((d) => d.label && REAR_CAMERA_PATTERN.test(d.label));
  if (named.length > 0) {
    return { video: { deviceId: { exact: named[0].deviceId } }, audio: wantAudio };
  }

  // Only one camera exposed: use it as-is rather than failing.
  if (cameras.length === 1) {
    return { video: { deviceId: { exact: cameras[0].deviceId } }, audio: wantAudio };
  }

  // Labels not available yet, so fall back to the facing-mode hints.
  return { video: { facingMode: { ideal: 'environment' } }, audio: wantAudio };
}

async function startStream() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('Este navegador no permite el uso de la cámara. Abre la página en un navegador moderno (Chrome, Edge, Safari).');
  }
  if (stream) return;

  const wantAudio = captureMode === 'video';
  let lastError = null;

  // First pass: pick the rear camera by enumerating devices. This also grants
  // the permission, which is what populates device labels on some browsers.
  try {
    const constraints = await getRearCameraConstraints(wantAudio);
    const candidate = await navigator.mediaDevices.getUserMedia(constraints);
    if (await videoIsLive(candidate)) {
      stream = candidate;
      return;
    }
    candidate.getTracks().forEach((t) => t.stop());
  } catch (err) {
    lastError = err;
  }

  // Second pass: retry the enumeration now that permission is granted, which
  // makes the device labels available to match the rear camera.
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const named = devices.filter(
      (d) => d.kind === 'videoinput' && d.label && REAR_CAMERA_PATTERN.test(d.label)
    );
    if (named.length > 0) {
      const candidate = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: named[0].deviceId } },
        audio: wantAudio,
      });
      if (await videoIsLive(candidate)) {
        stream = candidate;
        return;
      }
      candidate.getTracks().forEach((t) => t.stop());
    }
  } catch (err) {
    lastError = err;
  }

  // Last resort: whatever camera the device offers by default.
  try {
    const candidate = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: wantAudio,
    });
    if (await videoIsLive(candidate)) {
      stream = candidate;
      return;
    }
    candidate.getTracks().forEach((t) => t.stop());
  } catch (err) {
    lastError = err;
  }

  throw new Error(describeMediaError(lastError || {}));
}

function onStreamReady() {
  const video = document.getElementById('media-video');
  video.srcObject = stream;
  video.classList.remove('hide');
  document.getElementById('media-placeholder').classList.add('hide');
  video.play().catch(() => {});
}

  // The <video> element can report 0x0 until the first frame decodes.
function waitForVideoFrame(video, timeoutMs = 3000) {
  if (video.videoWidth > 0 && video.videoHeight > 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(video.videoWidth > 0 && video.videoHeight > 0);
    };
    const timer = setTimeout(done, timeoutMs);
    video.addEventListener('loadeddata', done, { once: true });
    video.addEventListener('resize', done, { once: true });
    video.addEventListener('canplay', done, { once: true });
  });
}

function describeMediaError(err) {
    const name = err?.name || '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'Permiso denegado. Habilita el acceso a la cámara o al micrófono en los permisos del navegador y vuelve a intentar.';
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      return 'No se encontró ninguna cámara o micrófono conectado.';
    }
    if (name === 'NotReadableError') {
      return 'La cámara está siendo usada por otra aplicación. Ciérrala e intenta de nuevo.';
    }
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      return 'El acceso a la cámara requiere una conexión segura (HTTPS). Abre el panel con la dirección https://.';
    }
    return err?.message || 'No se pudo acceder a la cámara.';
  }

  // A track exists but never delivers frames, so the preview would be black.
function videoIsLive(activeStream) {
  if (!activeStream) return Promise.resolve(false);
  const track = activeStream.getVideoTracks()[0];
  if (!track) return Promise.resolve(false);
  if (track.readyState !== 'live') return Promise.resolve(false);

  const settings = track.getSettings ? track.getSettings() : {};
  if (settings.width === 0 || settings.height === 0) return Promise.resolve(false);

  // Some Android builds report non-zero dimensions yet still render black for
  // a moment. Wait briefly for real dimensions before accepting the track.
  return new Promise((resolve) => {
    const probe = document.createElement('video');
    probe.muted = true;
    probe.playsInline = true;
    probe.srcObject = activeStream;
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      probe.srcObject = null;
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), 2500);
    probe.addEventListener('loadeddata', () => done(probe.videoWidth > 0 && probe.videoHeight > 0), { once: true });
    probe.addEventListener('error', () => done(false), { once: true });
    probe.play().catch(() => done(false));
  });
}

function stopStream() {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    const video = document.getElementById('media-video');
    if (video) video.srcObject = null;
  }

  function resetPreview() {
    const preview = document.getElementById('media-preview');
    preview.classList.add('hide');
    preview.innerHTML = '';
    document.getElementById('media-rec-indicator').classList.add('hide');
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  }

  function formatTime(ms) {
    const total = Math.floor(ms / 1000);
    const m = String(Math.floor(total / 60)).padStart(2, '0');
    const s = String(total % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  function onCaptureClick() {
    const label = document.getElementById('media-capture-label');

    // Second click stops an in-progress recording
    if (recorder && recorder.state === 'recording') {
      recorder.stop();
      return;
    }

    // Photo mode: take and hand off immediately
    if (captureMode === 'photo') {
      takePhoto();
      return;
    }

    startRecording(label);
  }

  async function takePhoto() {
    try {
      await startStream();
      onStreamReady();
    } catch (err) {
      alert(err.message);
      return;
    }
    const video = document.getElementById('media-video');
    const canvas = document.getElementById('media-canvas');
    // Wait for real dimensions, otherwise a slow track yields a black frame.
    await waitForVideoFrame(video);
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) { alert('No se pudo capturar la imagen.'); return; }
      stopStream();
      currentFileKind = 'photo';
      onFileReady(new File([blob], `captura_${Date.now()}.jpg`, { type: 'image/jpeg' }));
    }, 'image/jpeg', 0.9);
  }

  async function startRecording(label) {
    try {
      await startStream();
      onStreamReady();
    } catch (err) {
      alert(err.message);
      return;
    }

    chunks = [];
    const mimeType = pickMimeType(captureMode);
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      const kind = 'video';
      // Always stamp the Blob with an explicit container type. Some mobile
      // browsers produce chunks without one, which used to arrive at the
      // server as text/plain and get rejected.
      const blobType = mimeType || 'video/webm';
      const ext = mimeToExt(blobType);
      const blob = new Blob(chunks, { type: blobType });
      stopStream();
      resetPreview();
      setRecordingUI(false);
      if (blob.size === 0) { alert('No se grabó contenido.'); return; }
      currentFileKind = kind;
      onFileReady(new File([blob], `video_${Date.now()}.${ext}`, { type: blobType }));
    };

    recorder.start();
    startTime = Date.now();
    setRecordingUI(true);
    document.getElementById('media-rec-indicator').classList.remove('hide');

    const capBtn = document.getElementById('media-capture-btn');
    capBtn.querySelector('i').className = 'fa-solid fa-square';
    label.textContent = 'Detener';

    tickTimer = setInterval(() => {
      document.getElementById('media-rec-time').textContent = formatTime(Date.now() - startTime);
    }, 250);
  }

  function setRecordingUI(isRecording) {
    const capBtn = document.getElementById('media-capture-btn');
    capBtn.classList.toggle('recording', isRecording);
    const label = document.getElementById('media-capture-label');
    if (isRecording) {
      label.textContent = 'Detener';
    } else {
      const labels = { photo: 'Tomar foto', video: 'Grabar video' };
      label.textContent = labels[captureMode] || 'Capturar';
      if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    }
  }

  function pickMimeType() {
    const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
    for (const c of candidates) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c;
    }
    return '';
  }

  function mimeToExt(mime) {
    if (mime.includes('mp4')) return 'mp4';
    if (mime.includes('ogg')) return 'ogg';
    if (mime.includes('mpeg')) return 'mp3';
    return 'webm';
  }

  function onFileReady(file) {
    const preview = document.getElementById('media-preview');
    const url = URL.createObjectURL(file);
    preview.classList.remove('hide');
    preview.innerHTML = '';

    let media;
    if (file.type.startsWith('image/')) {
      media = document.createElement('img');
      media.src = url;
      media.alt = 'Vista previa';
    } else if (file.type.startsWith('video/')) {
      media = document.createElement('video');
      media.src = url;
      media.controls = true;
    } else if (file.type.startsWith('audio/')) {
      media = document.createElement('audio');
      media.src = url;
      media.controls = true;
    } else {
      media = document.createElement('p');
      media.className = 'text-muted';
      media.textContent = `Archivo listo: ${file.name}`;
    }
    preview.appendChild(media);

    const info = document.createElement('p');
    info.className = 'text-muted media-file-info';
    info.textContent = `${file.name} · ${(file.size / 1024).toFixed(0)} KB`;
    preview.appendChild(info);

    const sendBtn = document.createElement('button');
    sendBtn.type = 'button';
    sendBtn.className = 'btn btn-gradient media-send-btn';
    sendBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Analizar con el bot';
    sendBtn.addEventListener('click', () => {
      const questionEl = document.getElementById(currentQuestionId);
      const question = questionEl ? questionEl.value.trim() : '';
      const kind = currentFileKind;
      close();
      MediaCapture.onSubmit(file, question, kind);
    });
    preview.appendChild(sendBtn);
  }

  let currentFileKind = null;

  let currentQuestionId = 'play-chat-input';
  let submitHandler = null;

  function open(options = {}) {
    wire();
    captureMode = options.mode || 'photo';
    currentQuestionId = options.questionId || 'play-chat-input';
    submitHandler = options.onSubmit || null;

    document.querySelectorAll('.media-mode-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === captureMode);
    });
    const labels = { photo: 'Tomar foto', video: 'Grabar video' };
    document.getElementById('media-capture-label').textContent = labels[captureMode] || 'Capturar';
    const texts = {
      photo: 'Iniciando cámara...',
      video: 'Iniciando cámara...'
    };
    document.getElementById('media-placeholder-text').textContent = texts[captureMode] || 'Preparando...';

    resetPreview();
    stopStream();
    setRecordingUI(false);
    document.getElementById('media-modal').classList.add('active');

    // Start the camera as soon as the modal opens, otherwise the preview stays
    // black until the user presses the capture button.
    startStream().then(() => onStreamReady()).catch((err) => {
      const placeholder = document.getElementById('media-placeholder');
      placeholder.classList.remove('hide');
      document.getElementById('media-placeholder-text').textContent = err.message;
    });
  }

  function close() {
    if (recorder && recorder.state === 'recording') {
      try { recorder.stop(); } catch {}
      recorder = null;
    }
    stopStream();
    setRecordingUI(false);
    resetPreview();
    document.getElementById('media-modal').classList.remove('active');
  }

  return {
    open,
    close,
    // Calls the handler registered by open() once a capture is confirmed
    onSubmit(file, question, kind) {
      if (submitHandler) submitHandler(file, question, kind);
    }
  };
})();

window.MediaCapture = MediaCapture;