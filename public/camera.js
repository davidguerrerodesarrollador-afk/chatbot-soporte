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
            <button type="button" class="media-mode-btn" data-mode="audio">
              <i class="fa-solid fa-microphone"></i> Audio
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
          Si el navegador pide permiso, acéptalo. En celular se abrirá la cámara del teléfono;
          en computadora elige la cámara frontal o la trasera.
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
      input.accept = 'image/*,video/*,audio/*';
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
        document.getElementById('media-video').classList.add('hide');
        const texts = {
          photo: 'Presiona "Tomar foto" para abrir la cámara',
          video: 'Presiona "Grabar video" para abrir la cámara',
          audio: 'Presiona "Grabar audio" para usar el micrófono'
        };
        document.getElementById('media-placeholder-text').textContent = texts[captureMode];
        const label = document.getElementById('media-capture-label');
        const icons = { photo: 'Tomar foto', video: 'Grabar video', audio: 'Grabar audio' };
        label.textContent = icons[captureMode];
        const capBtn = document.getElementById('media-capture-btn');
        capBtn.classList.remove('recording');
        capBtn.querySelector('i').className = 'fa-solid fa-circle';
      });
    });

    // Stop the camera when the modal is dismissed with the backdrop
    document.getElementById('media-modal').addEventListener('click', (e) => {
      if (e.target.id === 'media-modal') close();
    });
  }

  function ensureAudioOnly() {
    stream.getAudioTracks().forEach((t) => t.stop());
  }

  async function startStream() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Este navegador no permite el uso de la cámara. Abre la página en un navegador moderno (Chrome, Edge, Safari).');
    }
    if (stream) return;

    const wants = captureMode === 'audio'
      ? { audio: true }
      : { video: true, audio: captureMode === 'video' };

    try {
      stream = await navigator.mediaDevices.getUserMedia(wants);
    } catch (err) {
      // Fall back to the other camera if the preferred one is unavailable
      if (captureMode !== 'audio') {
        try {
          stream = await navigator.mediaDevices.getUserMedia(
            captureMode === 'photo' ? { video: true } : { video: true, audio: true }
          );
        } catch {
          throw new Error(describeMediaError(err));
        }
      } else {
        throw new Error(describeMediaError(err));
      }
    }

    // Some mobile browsers honor facingMode but hand back a track that never
    // produces frames, showing a black screen. Retry with a bare video track.
    if (captureMode !== 'audio' && !videoIsLive(stream)) {
      stopStream();
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: true });
      } catch {
        // keep the original stream, it may still work
      }
    }

    const video = document.getElementById('media-video');
    video.srcObject = stream;
    video.classList.toggle('hide', captureMode === 'audio');
    document.getElementById('media-placeholder').classList.toggle('hide', captureMode !== 'audio');
    video.play().catch(() => {});
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
  if (!activeStream) return false;
  const track = activeStream.getVideoTracks()[0];
  if (!track) return false;
  const settings = track.getSettings ? track.getSettings() : {};
  if (settings.width === 0 || settings.height === 0) return false;
  return track.readyState === 'live';
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
    } catch (err) {
      alert(err.message);
      return;
    }
    const video = document.getElementById('media-video');
    const canvas = document.getElementById('media-canvas');
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
    } catch (err) {
      alert(err.message);
      return;
    }

    chunks = [];
    const mimeType = pickMimeType(captureMode);
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      const kind = captureMode === 'audio' ? 'audio' : 'video';
      const ext = mimeType ? mimeToExt(mimeType) : (kind === 'audio' ? 'webm' : 'webm');
      const base = kind;
      // Always stamp the Blob with an explicit container type. Some mobile
      // browsers produce chunks without one, which used to arrive at the
      // server as text/plain and get rejected.
      const blobType = mimeType || containerMime(kind);
      const blob = new Blob(chunks, { type: blobType });
      stopStream();
      resetPreview();
      setRecordingUI(false);
      if (blob.size === 0) { alert('No se grabó contenido.'); return; }
      currentFileKind = kind;
      onFileReady(new File([blob], `${base}_${Date.now()}.${ext}`, { type: blobType }));
    };

    recorder.start();
    startTime = Date.now();
    setRecordingUI(true);
    document.getElementById('media-rec-indicator').classList.remove('hide');

    if (captureMode === 'audio') ensureAudioOnly();

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
      const labels = { photo: 'Tomar foto', video: 'Grabar video', audio: 'Grabar audio' };
      label.textContent = labels[captureMode] || 'Capturar';
      if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    }
  }

  function pickMimeType(mode) {
    const candidates = mode === 'audio'
      ? ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']
      : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
    for (const c of candidates) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c;
    }
    return '';
  }

  // Prefer the container that matches the declared recording kind, so the Blob
  // carries a usable MIME instead of text/plain.
  function containerMime(mode) {
    return mode === 'audio' ? 'audio/webm' : 'video/webm';
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
    const labels = { photo: 'Tomar foto', video: 'Grabar video', audio: 'Grabar audio' };
    document.getElementById('media-capture-label').textContent = labels[captureMode];
    const texts = {
      photo: 'Presiona "Tomar foto" para abrir la cámara',
      video: 'Presiona "Grabar video" para abrir la cámara',
      audio: 'Presiona "Grabar audio" para usar el micrófono'
    };
    document.getElementById('media-placeholder-text').textContent = texts[captureMode];

    resetPreview();
    stopStream();
    setRecordingUI(false);
    document.getElementById('media-modal').classList.add('active');
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