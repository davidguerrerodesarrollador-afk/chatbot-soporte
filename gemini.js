import { JWT } from 'google-auth-library';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const LOCATION = 'us-central1';
let authClient = null;
let projectId = null;
let apiKeyFallback = null;
let aiClientFallback = null;

const MODEL_NAME = 'gemini-2.0-flash';
const EMBEDDING_MODEL = 'text-embedding-004';

function tryParseJSON(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function extractField(raw, field) {
  const re = new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`, 's');
  const m = raw.match(re);
  return m ? m[1] : null;
}

let saDiagnosticDone = false;

function getServiceAccountCredentials() {
  const envVar = process.env.SERVICE_ACCOUNT_JSON;
  if (envVar) {
    if (!saDiagnosticDone) {
      saDiagnosticDone = true;
      console.log(`[SA] SERVICE_ACCOUNT_JSON length=${envVar.length} startsWith=${envVar.substring(0, 20)}` +
        ` endsWith=${envVar.substring(envVar.length - 20).replace(/\n/, '\\n')}`);
    }

    let parsed = tryParseJSON(envVar);
    if (parsed) return parsed;

    // Node.js Buffer.from(..., 'base64') ignores non-base64 characters.
    // Try decoding even if the string isn't pure base64.
    try {
      const decoded = Buffer.from(envVar, 'base64').toString('utf-8').replace(/\0/g, '');
      parsed = tryParseJSON(decoded);
      if (parsed) return parsed;
    } catch {}

    // Manual field extraction on the raw env var
    const project_id = extractField(envVar, 'project_id');
    const client_email = extractField(envVar, 'client_email');
    let private_key = extractField(envVar, 'private_key');
    if (private_key) private_key = private_key.replace(/\\n/g, '\n');

    if (project_id && client_email && private_key) {
      console.log('[SA] Fields extracted manually OK');
      return { project_id, client_email, private_key };
    }

    throw new Error('SERVICE_ACCOUNT_JSON: no se pudo parsear');
  }
  if (fs.existsSync('./service-account.json')) {
    return JSON.parse(fs.readFileSync('./service-account.json', 'utf-8'));
  }
  return null;
}

async function ensureAuth() {
  if (authClient) return 'vertex';
  const key = getServiceAccountCredentials();
  if (key) {
    projectId = key.project_id;
    authClient = new JWT({
      email: key.client_email,
      key: key.private_key,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    console.log('[Gemini] Using Vertex AI (service account)');
    return 'vertex';
  }
  // Fallback to Gemini API key
  if (!apiKeyFallback) {
    apiKeyFallback = process.env.GEMINI_API_KEY;
    if (!apiKeyFallback || apiKeyFallback.includes('your_gemini_api_key')) {
      throw new Error('No credentials available for Gemini');
    }
    const { GoogleGenAI } = await import('@google/genai');
    aiClientFallback = new GoogleGenAI({ apiKey: apiKeyFallback });
    console.log('[Gemini] Using Gemini API (API key fallback)');
  }
  return 'api-key';
}

function extractText(response) {
  if (response.candidates?.[0]?.content?.parts?.[0]?.text) {
    return response.candidates[0].content.parts[0].text;
  }
  // Handle Gemini API SDK response
  if (response.text) return response.text;
  return null;
}

export async function generateSummary(localFilePath, mimeType, fileName) {
  const mode = await ensureAuth();
  const buffer = fs.readFileSync(localFilePath);
  const base64Data = buffer.toString('base64');

  const prompt = `You are a professional documentation indexer. Analyze the provided file (Filename: "${fileName}") which is part of a machine manual and technical knowledge base.
Provide a highly detailed, comprehensive, and structured technical description and summary of all instructions, specifications, troubleshooting steps, error codes, visual details, or operations shown or written in this file. 
Ensure you capture every specific detail: machine models, error numbers (e.g. E03, F21), exact measurements, step-by-step resolution processes, parts list, and warnings.
Write the entire summary in Spanish (español). Your summary will be used for a retrieval-augmented generation (RAG) system to answer operator questions. Do not write a generic summary; make it as technical and detailed as possible.
Format your output using clean Markdown headers, bullet points, and tables if necessary.`;

  console.log(`[Gemini] Analyzing file "${fileName}" with ${mode}...`);

  if (mode === 'vertex') {
    const response = await authClient.request({
      url: `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${LOCATION}/publishers/google/models/${MODEL_NAME}:generateContent`,
      method: 'POST',
      data: {
        contents: [{ role: 'user', parts: [
          { text: prompt },
          { inlineData: { mimeType, data: base64Data } }
        ]}]
      }
    });
    const summary = extractText(response.data) || 'No summary could be generated.';
    console.log(`[Gemini] Summary generated for "${fileName}" (${summary.length} chars).`);
    return summary;
  }

  // API key fallback
  const response = await aiClientFallback.models.generateContent({
    model: MODEL_NAME,
    contents: [{ role: 'user', parts: [
      { text: prompt },
      { inlineData: { mimeType, data: base64Data } }
    ]}]
  });
  const summary = response.text || 'No summary could be generated.';
  console.log(`[Gemini] Summary generated for "${fileName}" (${summary.length} chars).`);
  return summary;
}

export async function generateEmbedding(text) {
  const mode = await ensureAuth();

  if (mode === 'vertex') {
    const response = await authClient.request({
      url: `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${LOCATION}/publishers/google/models/${EMBEDDING_MODEL}:predict`,
      method: 'POST',
      data: {
        instances: [{ content: text }]
      }
    });
    const prediction = response.data.predictions?.[0];
    if (prediction?.embeddings?.values) {
      return prediction.embeddings.values;
    }
    if (prediction?.embeddings?.statistics) {
      return prediction.embeddings.values;
    }
    throw new Error('Embedding values not found in response');
  }

  // API key fallback
  const response = await aiClientFallback.models.embedContent({
    model: EMBEDDING_MODEL,
    contents: text,
  });
  const embeddingObj = response.embedding || (response.embeddings && response.embeddings[0]);
  if (embeddingObj?.values) return embeddingObj.values;
  throw new Error('Embedding values not found');
}

export async function prepareMediaPart(localFilePath, mimeType) {
  const buffer = fs.readFileSync(localFilePath);
  return { inlineData: { mimeType, data: buffer.toString('base64') } };
}

export async function answerQuestion(question, sources, mediaParts = []) {
  const mode = await ensureAuth();

  let context = '';
  if (sources.length === 0) {
    context = 'No se encontró documentación técnica en la base de datos.';
  } else {
    context = sources.map((s, i) =>
      `--- DOCUMENTO ${i + 1}: ${s.name} ---\n${s.summary}`
    ).join('\n');
  }

  const systemInstructionText = `Eres un asistente profesional de mantenimiento de máquinas. Debes responder la pregunta del usuario usando ÚNICAMENTE los resúmenes de la documentación técnica proporcionados.
Reglas:
1. Apóyate estrictamente en el contexto. Si no contiene la respuesta, dile que no has encontrado la solución.
2. Si la pregunta no está relacionada, recuérdale que eres un asistente de mantenimiento.
3. Sé profesional, claro y directo. Desglosa soluciones en pasos numerados.
4. Referencia los nombres de los documentos de donde obtuviste la información.
5. Responde SIEMPRE en español.

Contexto:
${context}

Fin del contexto.`;

  const parts = [...mediaParts, { text: question }];

  if (mode === 'vertex') {
    const response = await authClient.request({
      url: `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${LOCATION}/publishers/google/models/${MODEL_NAME}:generateContent`,
      method: 'POST',
      data: {
        system_instruction: { parts: [{ text: systemInstructionText }] },
        contents: [{ role: 'user', parts }]
      }
    });
    return extractText(response.data) || 'No pude formular una respuesta.';
  }

  const response = await aiClientFallback.models.generateContent({
    model: MODEL_NAME,
    contents: [{ role: 'user', parts }],
    config: { systemInstruction: systemInstructionText }
  });
  return response.text || 'No pude formular una respuesta.';
}
