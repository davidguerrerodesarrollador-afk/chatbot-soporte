import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import XLSX from 'xlsx';
import dotenv from 'dotenv';

dotenv.config();

let aiClient = null;
const MODEL_NAME = 'gemini-2.5-flash';
const EMBEDDING_MODEL = 'gemini-embedding-2';

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
function normalizeMimeType(mimeType, fileName = '', filePath = '') {
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
  if (reportedIsUseless && byExt) return byExt;

  // 4. Otherwise keep what Drive reported, but never hand back an empty value
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
  const uploadResult = await ai.files.upload({
    file: localFilePath,
    mimeType: effectiveMimeType,
  });

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
    const prompt = `You are a professional documentation indexer. Analyze the provided file (Filename: "${fileName}") which is part of the organization's internal administrative knowledge base.
Provide a highly detailed, comprehensive, and structured description and summary of all procedures, policies, regulations, requirements, steps, deadlines, amounts, forms, requirements and details shown or written in this file.
Ensure you capture every specific detail: names of areas or departments, applicable concepts (e.g. viáticos, facturas, vacaciones, compras), exact figures, deadlines, step-by-step resolution processes, required documents or forms, and warnings.
If the file content is in any language other than Spanish, translate ALL content entirely into Spanish. The output summary must be 100% in Spanish. Your summary will be used for a retrieval-augmented generation (RAG) system to answer employee questions in Spanish. Do not write a generic summary; make it as specific and detailed as possible.
Format your output using clean Markdown headers, bullet points, and tables if necessary.`;

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
 * @returns {Promise<object>} A Gemini content part object ({inlineData} or {fileData}).
 */
export async function prepareMediaPart(localFilePath, mimeType) {
  const ai = getGeminiClient();
  if (!ai) throw new Error('Gemini API client is not initialized.');

  const fileName = localFilePath.split(/[\\/]/).pop() || '';
  mimeType = normalizeMimeType(mimeType, fileName, localFilePath);

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

  // Videos and large audio files: upload to File API and reference by URI
  const uploadResult = await ai.files.upload({ file: localFilePath, mimeType });

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
export async function answerQuestion(question, sources, mediaParts = []) {
  const ai = getGeminiClient();
  if (!ai) {
    throw new Error('Gemini API client is not initialized.');
  }

  let context = '';
  if (sources.length === 0) {
    context = 'No se encontró documentación en la base de datos.';
  } else {
    context = sources.map((source, index) => {
      return `--- DOCUMENTO ${index + 1}: ${source.name} ---\n${source.summary}\n`;
    }).join('\n');
  }

  const systemPrompt = `Eres un asistente administrativo interno de la organización. Tu trabajo es resolver las dudas de los colaboradores sobre temas administrativos, contables, financieros, de recursos humanos, de compras, de inventario, de facturación y cualquier otro procedimiento interno documentado.
Debes responder la pregunta del usuario usando ÚNICAMENTE los resúmenes de la documentación proporcionados y las imágenes o videos que el usuario haya adjuntado.
Reglas:
1. Apóyate estrictamente en el contexto proporcionado y en el contenido de las imágenes/videos. Si el contexto no contiene la respuesta, dile amablemente al usuario que no has encontrado la información en los documentos subidos y que contacte al área responsable. No inventes ni alucines respuestas, importes, plazos, políticas ni nombres de personas.
2. Si la pregunta del usuario no está relacionada con la documentación (por ejemplo, conversación general o temas técnicos de programación), recuérdale con amabilidad que eres un asistente administrativo y que solo puedes ayudar con procedimientos e información documentados en la carpeta del administrador. Nunca te describas como asistente de mantenimiento de máquinas ni de soporte técnico.
3. Sé profesional, claro y directo. Desglosa las respuestas en pasos numerados claros cuando el procedimiento lo requiera.
4. Referencia los nombres de los documentos (ej: [Politica-de-Gastos.pdf]) de donde obtuviste la información.
5. Responde SIEMPRE en español, incluso si el usuario te pregunta en otro idioma.

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
