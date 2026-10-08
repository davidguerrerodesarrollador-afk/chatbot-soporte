import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import XLSX from 'xlsx';
import dotenv from 'dotenv';

dotenv.config();

let aiClient = null;
const MODEL_NAME = 'gemini-2.5-flash';
const EMBEDDING_MODEL = 'gemini-embedding-2';

// Bumped whenever MIME handling changes, so error messages reveal which build
// is deployed instead of guessing.
const BUILD_ID = 'config-mime-3';

const VIDEO_EXTENSIONS = /\.(mkv|mp4|mov|m4v|avi|3gp|flv|wmv|ogv)$/i;
const AUDIO_ONLY_EXTENSIONS = /\.(ogg|oga|opus|mp3|m4a|wav|aac|flac|wma)$/i;

// MediaRecorder in Chrome/Safari records both video and audio as .webm, so the
// extension alone cannot tell them apart. The caller knows which mode it used.
const MEDIA_RECORDER_EXTENSIONS = /\.(webm|weba)$/i;

function isVideoName(fileName = '') {
  return VIDEO_EXTENSIONS.test(fileName);
}

function isMediaRecorderName(fileName = '') {
  return MEDIA_RECORDER_EXTENSIONS.test(fileName);
}

function isAudioOnlyName(fileName = '') {
  return AUDIO_ONLY_EXTENSIONS.test(fileName);
}

/**
 * Detect a MIME type from the file's magic bytes.
 * More reliable than the MIME Google Drive reports, which describes the
 * container and can be empty or unsupported (e.g. .jfif, .heic, .m4a).
 */
function sniffMimeType(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);

    // ISO base media (mp4/m4a/mov/3gp/heic): ....ftyp<brand>
    if (buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp') {
      const brand = buf.toString('latin1', 8, 12).toLowerCase();
      if (brand.startsWith('heic') || brand.startsWith('heix') || brand.startsWith('mif1')) return 'image/heic';
      if (brand.startsWith('m4a')) return 'audio/mp4';
      if (brand.startsWith('qt')) return 'video/quicktime';
      if (brand.startsWith('3g')) return 'video/3gpp';
      return 'video/mp4';
    }

    // RIFF....WEBP
    if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
    // RIFF....WAVE
    if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WAVE') return 'audio/wav';
    // OGG
    if (buf.toString('latin1', 0, 4) === 'OggS') return 'audio/ogg';
    // fLaC
    if (buf.toString('latin1', 0, 4) === 'fLaC') return 'audio/flac';
    // ID3 or MPEG frame sync -> MP3
    if (buf.toString('latin1', 0, 3) === 'ID3') return 'audio/mpeg';
    if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'audio/mpeg';
    // JPEG / JFIF share the SOI + APP0 JFIF marker
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
    // PNG
    if (buf.toString('latin1', 0, 8) === '\x89PNG\r\n\x1a\n') return 'image/png';
    // GIF
    if (buf.toString('latin1', 0, 3) === 'GIF') return 'image/gif';
    // BMP
    if (buf.toString('latin1', 0, 2) === 'BM') return 'image/bmp';
    // EBML -> Matroska/WebM
    if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'video/x-matroska';
    // PDF
    if (buf.toString('latin1', 0, 4) === '%PDF') return 'application/pdf';
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
  return null;
}

// Extensions whose bytes match a supported format but whose container
// Gemini's File API does not list.
const BY_EXTENSION = {
  jfif: 'image/jpeg', jpe: 'image/jpeg', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  heic: 'image/heic', heif: 'image/heif',
  m4a: 'audio/mp4', aac: 'audio/mp4', opus: 'audio/ogg', oga: 'audio/ogg',
  mp3: 'audio/mpeg', wav: 'audio/wav',
  m4v: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', '3gp': 'video/3gpp',
  png: 'image/png', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp',
  mp4: 'video/mp4', webm: 'video/webm', avi: 'video/mp4', flv: 'video/mp4',
  ogg: 'audio/ogg', wma: 'audio/mp3',
  csv: 'text/plain', tsv: 'text/plain', txt: 'text/plain', pdf: 'application/pdf',
};

// Reported MIME values that need remapping to a supported type.
const MIME_ALIASES = {
  'image/jfif': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-jfif': 'image/jpeg',
  'audio/mp3': 'audio/mpeg',
  'audio/x-m4a': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'audio/x-mp4': 'audio/mp4',
  'audio/x-wav': 'audio/wav',
  'audio/vnd.wave': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/x-flac': 'audio/flac',
  'audio/x-ms-wma': 'audio/mp3',
  'video/x-m4v': 'video/mp4',
  'video/avi': 'video/mp4',
  'video/x-msvideo': 'video/mp4',
};

/**
 * Resolve a MIME type the Gemini File API will accept.
 * Priority: magic bytes > reported MIME > file extension. Never returns an
 * empty value, because the SDK fails with "Can not determine mimeType".
 */
export function normalizeMimeType(mimeType, fileName = '', filePath = '', declaredKind = null) {
  const reported = (mimeType || '').toLowerCase().trim();
  const ext = (fileName.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  const byExt = BY_EXTENSION[ext];

  // 1. Magic bytes are the most trustworthy source
  if (filePath) {
    const sniffed = sniffMimeType(filePath);
    if (sniffed) return sniffed;
  }

  // 2. Remap known aliases / bare extensions reported by Drive
  if (MIME_ALIASES[reported]) return MIME_ALIASES[reported];

  // 3. Trust the extension when Drive gave nothing usable
  const reportedIsUseless =
    !reported ||
    reported === 'application/octet-stream' ||
    reported === 'binary/octet-stream' ||
    !reported.includes('/');
  const reportedIsGenericContainer = reported === 'text/plain';

  // Browsers hand us MediaRecorder output with an empty or generic type. The
  // declared recording kind is more reliable than the extension, because
  // MediaRecorder writes .webm for both video and audio.
  if (declaredKind === 'video' && (reportedIsUseless || reportedIsGenericContainer)) return 'video/webm';
  if (declaredKind === 'audio' && (reportedIsUseless || reportedIsGenericContainer)) return 'audio/webm';

  if (reportedIsUseless && byExt) return byExt;

  // 4. No declared kind, so infer from the extension
  if (reportedIsUseless || reportedIsGenericContainer) {
    if (isVideoName(fileName)) return 'video/webm';
    if (isAudioOnlyName(fileName)) return 'audio/webm';
    if (isMediaRecorderName(fileName)) return 'video/webm';
    // text/plain on a real text file is correct; keep it
    if (reported === 'text/plain' && !byExt) return 'text/plain';
    if (byExt) return byExt;
  }

  // 5. Otherwise keep what Drive reported, but never hand back an empty value
  if (reported && reported !== 'application/octet-stream') return reported;
  return byExt || 'application/octet-stream';
}

// Initialize Gemini Client
export function getGeminiClient() {
  if (aiClient) return aiClient;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.includes('your_gemini_api_key')) {
    console.warn('⚠️ GEMINI_API_KEY is not configured in .env');
    return null;
  }

  aiClient = new GoogleGenAI({ apiKey });
  return aiClient;
}

/**
 * Upload a local file to Gemini File API, wait for it to process if necessary,
 * generate a detailed technical summary, and delete it from Gemini's storage.
 * @param {string} localFilePath Local path to the file.
 * @param {string} mimeType File MIME type.
 * @param {string} fileName Original file name.
 * @returns {Promise<string>} Gemini-generated technical summary.
 */
export async function generateSummary(localFilePath, mimeType, fileName) {
  const ai = getGeminiClient();
  if (!ai) {
    throw new Error('Gemini API client is not initialized. Please set GEMINI_API_KEY in .env.');
  }

  // For Excel files, read content directly (File API doesn't support spreadsheets)
  const isExcel = mimeType.includes('spreadsheet') || fileName.match(/\.xlsx?$/i);
  if (isExcel) {
    console.log(`[Gemini] Excel file detected. Reading content locally...`);
    const workbook = XLSX.readFile(localFilePath);
    let textContent = '';
    workbook.SheetNames.forEach(sheetName => {
      const sheet = workbook.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(sheet);
      textContent += `--- Hoja: ${sheetName} ---\n${csv}\n\n`;
    });

    const prompt = `You are a professional documentation indexer. The following is the content extracted from a spreadsheet file (Filename: "${fileName}").
Analyze ALL the data, rows, columns, and values shown. Provide a highly detailed, comprehensive, and structured technical description and summary of all information contained in this file.
If the content is in any language other than Spanish, translate ALL content entirely into Spanish. The output summary must be 100% in Spanish. Your summary will be used for a retrieval-augmented generation (RAG) system to answer operator questions in Spanish. Do not write a generic summary; make it as technical and detailed as possible.
Format your output using clean Markdown headers, bullet points, and tables if necessary.

Contenido del archivo:
${textContent}`;

    console.log(`[Gemini] Analyzing Excel file "${fileName}" with model ${MODEL_NAME}...`);
    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });
    const summary = response.text || 'No summary could be generated.';
    console.log(`[Gemini] Successfully generated summary for "${fileName}" (${summary.length} characters).`);
    return summary;
  }

  // For CSV/text files (e.g. exported Google Sheets), read content directly
  const isText = mimeType === 'text/csv' || mimeType === 'text/plain' || mimeType === 'text/tab-separated-values' || fileName.match(/\.(csv|tsv|txt)$/i);
  if (isText) {
    console.log(`[Gemini] Text/CSV file detected. Reading content locally...`);
    const textContent = fs.readFileSync(localFilePath, 'utf-8');

    const prompt = `You are a professional documentation indexer. The following is the content extracted from a data file (Filename: "${fileName}").
Analyze ALL the data, rows, columns, and values shown. Provide a highly detailed, comprehensive, and structured technical description and summary of all information contained in this file.
If the content is in any language other than Spanish, translate ALL content entirely into Spanish. The output summary must be 100% in Spanish. Your summary will be used for a retrieval-augmented generation (RAG) system to answer operator questions in Spanish. Do not write a generic summary; make it as technical and detailed as possible.
Format your output using clean Markdown headers, bullet points, and tables if necessary.

Contenido del archivo:
${textContent}`;

    console.log(`[Gemini] Analyzing Excel file "${fileName}" with model ${MODEL_NAME}...`);
    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });
    const summary = response.text || 'No summary could be generated.';
    console.log(`[Gemini] Successfully generated summary for "${fileName}" (${summary.length} characters).`);
    return summary;
  }

  const effectiveMimeType = normalizeMimeType(mimeType, fileName, localFilePath);
  if (effectiveMimeType !== mimeType) {
    console.log(`[Gemini] Normalized MIME "${mimeType}" -> "${effectiveMimeType}" for "${fileName}"`);
  }

  console.log(`[Gemini] Uploading "${fileName}" (${effectiveMimeType}) to Gemini File API...`);
  let uploadResult;
  try {
    // The SDK reads mimeType from params.config (see Files.upload ->
    // uploadFile(params.file, params.config)). Passing it at the top level
    // is silently ignored and the SDK then infers it from the file extension,
    // which fails for extensions like .jfif.
    uploadResult = await ai.files.upload({
      file: localFilePath,
      config: { mimeType: effectiveMimeType }
    });
  } catch (uploadError) {
    // Surface what we detected: this distinguishes a MIME problem from a
    // missing/renamed field, and confirms which build is actually running.
    throw new Error(
      `Gemini File API rechazó "${fileName}" ` +
      `(Drive reportó: "${mimeType || 'vacío'}", detectado: "${effectiveMimeType}", ` +
      `build: ${BUILD_ID}): ${uploadError.message}`
    );
  }

  console.log(`[Gemini] Upload complete. File URI: ${uploadResult.uri}. Name: ${uploadResult.name}`);

  try {
    // Wait for the file to be processed if it is a video
    if (effectiveMimeType.startsWith('video/')) {
      console.log(`[Gemini] Video file detected. Waiting for processing...`);
      let fileState = await ai.files.get({ name: uploadResult.name });
      let attempts = 0;
      while (fileState.state === 'PROCESSING' && attempts < 20) {
        attempts++;
        console.log(`[Gemini] Video state: PROCESSING (check ${attempts}/20). Waiting 5s...`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
        fileState = await ai.files.get({ name: uploadResult.name });
      }

      if (fileState.state !== 'ACTIVE') {
        throw new Error(`Gemini File API processing failed with state: ${fileState.state}`);
      }
      console.log(`[Gemini] Video processing finished. State: ACTIVE`);
    }

    // Prompt Gemini for an exhaustive summary
    const prompt = `You are a professional document indexer. Analyze the provided file (Filename: "${fileName}") and describe exactly what it contains.

Describe the content thoroughly and factually, whatever the subject matter is. There are no restrictions on subject: describe objects, people, places, products, artworks, events, screenshots, diagrams, scenery, text, numbers, concepts, or anything else you can actually observe in the file.

Important:
- Never state that the content is "not administrative", "not relevant", "not useful", or "outside the scope" of anything. Such judgments are forbidden.
- Never produce a list of what the file does NOT contain, and never mention missing categories such as policies, deadlines, amounts, procedures, or departments. If a category is absent, simply do not bring it up.
- If the file has little text, describe the visual content in detail instead: what is shown, what it looks like, colors, objects, setting, and any readable text.
- Be specific. Mention names, numbers, dates, colors, and visible text verbatim when present.

If the file content is in any language other than Spanish, translate everything into Spanish. The output must be 100% in Spanish. Your summary will be used by a retrieval-augmented generation (RAG) system to answer questions about these files, so capture enough detail that someone can find and understand this file later.
Format your output using clean Markdown headers and bullet points.`;

    console.log(`[Gemini] Analyzing file "${fileName}" with model ${MODEL_NAME}...`);
    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: [
        {
          role: 'user',
          parts: [
            { text: prompt },
            { fileData: { fileUri: uploadResult.uri, mimeType: uploadResult.mimeType } }
          ]
        }
      ]
    });

    const summary = response.text || 'No summary could be generated.';
    console.log(`[Gemini] Successfully generated summary for "${fileName}" (${summary.length} characters).`);
    return summary;

  } finally {
    // Always clean up the file from Gemini File API
    try {
      console.log(`[Gemini] Deleting file ${uploadResult.name} from Gemini File API...`);
      await ai.files.delete({ name: uploadResult.name });
      console.log(`[Gemini] Deleted file ${uploadResult.name} successfully.`);
    } catch (err) {
      console.error(`[Gemini] Error cleaning up file ${uploadResult.name}:`, err);
    }
  }
}

/**
 * Generate a 768-dimension vector embedding for text.
 * @param {string} text Text content to embed.
 * @returns {Promise<Array<number>>} The vector embedding array.
 */
export async function generateEmbedding(text) {
  const ai = getGeminiClient();
  if (!ai) {
    throw new Error('Gemini API client is not initialized. Please set GEMINI_API_KEY in .env.');
  }

  try {
    const response = await ai.models.embedContent({
      model: EMBEDDING_MODEL,
      contents: text,
    });

    const embeddingObj = response.embedding || (response.embeddings && response.embeddings[0]);
    if (embeddingObj && embeddingObj.values) {
      return embeddingObj.values;
    } else {
      throw new Error('Embedding values not found in response');
    }
  } catch (error) {
    console.error('[Gemini] Error generating embedding:', error);
    throw error;
  }
}

/**
 * Prepare a media file as a Gemini content part.
 * Images and small audio files are sent as inline base64 data (no File API needed).
 * Videos and large audio files are uploaded to the File API and referenced by URI.
 * @param {string} localFilePath Local path to the file.
 * @param {string} mimeType File MIME type.
 * @param {'video'|'audio'|null} declaredKind What the browser recorded, when the
 *   file extension can't tell (MediaRecorder writes .webm for both).
 * @returns {Promise<object>} A Gemini content part object ({inlineData} or {fileData}).
 */
export async function prepareMediaPart(localFilePath, mimeType, declaredKind = null) {
  const ai = getGeminiClient();
  if (!ai) throw new Error('Gemini API client is not initialized.');

  const fileName = localFilePath.split(/[\\/]/).pop() || '';
  mimeType = normalizeMimeType(mimeType, fileName, localFilePath, declaredKind);

  // Images: send as inline base64 data
  if (mimeType.startsWith('image/')) {
    const buffer = fs.readFileSync(localFilePath);
    const base64 = buffer.toString('base64');
    return { inlineData: { mimeType, data: base64 } };
  }

  // Audio (e.g. Chat voice messages): inline when small to skip the File API round-trip
  if (mimeType.startsWith('audio/')) {
    const buffer = fs.readFileSync(localFilePath);
    if (buffer.length <= 15 * 1024 * 1024) {
      return { inlineData: { mimeType, data: buffer.toString('base64') } };
    }
  }

  // Videos and large audio files: upload to File API and reference by URI.
  // mimeType must live inside `config` or the SDK ignores it.
  const uploadResult = await ai.files.upload({
    file: localFilePath,
    config: { mimeType }
  });

  let fileState = await ai.files.get({ name: uploadResult.name });
  let attempts = 0;
  while (fileState.state === 'PROCESSING' && attempts < 20) {
    attempts++;
    await new Promise((resolve) => setTimeout(resolve, 5000));
    fileState = await ai.files.get({ name: uploadResult.name });
  }
  if (fileState.state !== 'ACTIVE') {
    throw new Error(`Gemini File API processing failed with state: ${fileState.state}`);
  }

  return { fileData: { fileUri: uploadResult.uri, mimeType } };
}

/**
 * Generate a troubleshooting answer using relevant document summaries as context,
 * optionally including media (images as inlineData, videos as fileData).
 * @param {string} question The operator's question.
 * @param {Array<object>} sources Array of file objects containing { name, summary }.
 * @param {Array<object>} [mediaParts=[]] Array of pre-built Gemini content parts ({inlineData} or {fileData}).
 * @returns {Promise<string>} The troubleshooting answer.
 */
export function getBuildId() {
  return BUILD_ID;
}

export async function answerQuestion(question, sources, mediaParts = [], options = {}) {
  const ai = getGeminiClient();
  if (!ai) {
    throw new Error('Gemini API client is not initialized.');
  }

let context = '';
  if (sources.length === 0) {
    context = 'NO HAY DOCUMENTACIÓN DISPONIBLE. La base de datos está vacía o ningún documento coincide con la consulta. Debes indicar que no encontraste información en los documentos cargados, sin recurrir a tu conocimiento propio.';
  } else {
    context = sources.map((source, index) => {
      return `--- DOCUMENTO ${index + 1}: ${source.name} ---\n${source.summary}\n`;
    }).join('\n');
  }

  // describeOnly is used internally to turn an attachment into search terms.
  // It runs before any document is known, so the strict grounding rule would
  // block it from describing the file at all.
  const describeOnly = options.describeOnly === true;

  const systemPrompt = describeOnly
    ? `Describe con máximo detalle el contenido del archivo adjunto (imagen, video o audio): qué se ve, qué objetos aparecen, qué textos son legibles, nombres, números, códigos y cualquier detalle observable.

Este texto se usará internamente para buscar documentos relacionados, así que incluye palabras clave concretas y específicas.

Responde SIEMPRE en español. No añadas juicios ni comentarios sobre si el contenido es relevante para algún área.`
    : `Eres un asistente de consulta documental. Respondes únicamente a partir de la documentación que el administrador ha cargado y de los archivos que el usuario adjunta en este mensaje.

REGLA FUNDAMENTAL
Tu única fuente de información es el "Contexto de la documentación" y los archivos adjuntos. NO uses tu conocimiento propio, NO completes con lo que "probablemente" sea cierto, NO deduzcas valores que no estén escritos. Aunque conozcas la respuesta exacta, si no está en el contexto, no la puedes dar.

Reglas:
1. Basa la respuesta íntegramente en el contexto y en los archivos adjuntos. Cita siempre el documento del que tomaste cada dato: [Nombre-Del-Archivo.pdf].
2. Si el contexto no contiene la respuesta, dilo de forma breve y directa: que no encontraste ese dato en los documentos cargados. No inventes, no completes y no deduzcas números, códigos, modelos, procedimientos, plazos, valores ni nombres que no estén escritos en el contexto.
3. Si el usuario pregunta por algo general y el contexto tiene el detalle aplicable, responde con ese detalle. Si el contexto es demasiado ambiguo para responder, pide el dato específico que falta en lugar de suponer.
4. Si dos documentos del contexto se contradicen, indícalo claramente en lugar de elegir uno.
5. Analiza a fondo las imágenes, videos y audio adjuntos: describen lo que muestran y sirve para identificar cuál de los documentos aplica. Eso no cuenta como conocimiento propio, es lectura directa del archivo.
6. No hagas juicios sobre si el tema del usuario es "apropiado", "administrativo" o cualquier cosa similar. Simplemente responde o indica que no está en los documentos.
7. Sé claro y directo. Usa pasos numerados o tablas cuando el contenido lo requiera.
8. Responde SIEMPRE en español, incluso si el usuario pregunte en otro idioma.

Contexto de la documentación:
${context}

Fin del contexto.`;

  const parts = [...mediaParts, { text: question }];

  console.log(`[Gemini] Generating answer to: "${question}" with ${mediaParts.length} media part(s)...`);
  const response = await ai.models.generateContent({
    model: MODEL_NAME,
    contents: [{ role: 'user', parts }],
    config: {
      systemInstruction: systemPrompt
    }
  });

  return response.text || 'No pude formular una respuesta.';
}
