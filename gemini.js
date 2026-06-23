import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

let aiClient = null;
const MODEL_NAME = 'gemini-2.5-flash';
const EMBEDDING_MODEL = 'gemini-embedding-2';

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

  console.log(`[Gemini] Uploading "${fileName}" (${mimeType}) to Gemini File API...`);
  const uploadResult = await ai.files.upload({
    file: localFilePath,
    mimeType: mimeType,
  });

  console.log(`[Gemini] Upload complete. File URI: ${uploadResult.uri}. Name: ${uploadResult.name}`);

  try {
    // Wait for the file to be processed if it is a video
    if (mimeType.startsWith('video/')) {
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
    const prompt = `You are a professional documentation indexer. Analyze the provided file (Filename: "${fileName}") which is part of a machine manual and technical knowledge base.
Provide a highly detailed, comprehensive, and structured technical description and summary of all instructions, specifications, troubleshooting steps, error codes, visual details, or operations shown or written in this file. 
Ensure you capture every specific detail: machine models, error numbers (e.g. E03, F21), exact measurements, step-by-step resolution processes, parts list, and warnings.
Write the entire summary in Spanish (español). Your summary will be used for a retrieval-augmented generation (RAG) system to answer operator questions. Do not write a generic summary; make it as technical and detailed as possible.
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
 * Images are sent as inline base64 data (no File API needed).
 * Videos are uploaded to the File API and referenced by URI.
 * @param {string} localFilePath Local path to the file.
 * @param {string} mimeType File MIME type.
 * @returns {Promise<object>} A Gemini content part object ({inlineData} or {fileData}).
 */
export async function prepareMediaPart(localFilePath, mimeType) {
  const ai = getGeminiClient();
  if (!ai) throw new Error('Gemini API client is not initialized.');

  // Images: send as inline base64 data
  if (mimeType.startsWith('image/')) {
    const buffer = fs.readFileSync(localFilePath);
    const base64 = buffer.toString('base64');
    return { inlineData: { mimeType, data: base64 } };
  }

  // Videos: upload to File API and reference by URI
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
    context = 'No se encontró documentación técnica en la base de datos.';
  } else {
    context = sources.map((source, index) => {
      return `--- DOCUMENTO ${index + 1}: ${source.name} ---\n${source.summary}\n`;
    }).join('\n');
  }

  const systemPrompt = `Eres un asistente profesional de mantenimiento de máquinas. Tu trabajo es ayudar a los operarios de fábrica a resolver problemas con las máquinas.
Debes responder la pregunta del usuario usando ÚNICAMENTE los resúmenes de la documentación técnica proporcionados y las imágenes o videos que el usuario haya adjuntado.
Reglas:
1. Apóyate estrictamente en el contexto proporcionado y en el contenido de las imágenes/videos. Si el contexto no contiene la respuesta, dile amablemente al usuario que no has encontrado la solución en los manuales subidos. No inventes ni alucines respuestas.
2. Si la pregunta del usuario no está relacionada con la documentación (por ejemplo, preguntas de conversación general o programación), recuérdale que eres un asistente de mantenimiento de máquinas y solo puedes ayudar con problemas documentados en la carpeta del administrador.
3. Sé profesional, claro y directo. Desglosa las soluciones en pasos numerados claros e instrucciones paso a paso.
4. Referencia los nombres de los documentos (ej: [CNC-Router-Manual.pdf]) de donde obtuviste la información.
5. Responde SIEMPRE en español.

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
