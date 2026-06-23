import { OAuth2Client, JWT } from 'google-auth-library';
import { generateEmbedding, answerQuestion, prepareMediaPart } from './gemini.js';
import { searchSimilarFiles, logChat } from './database.js';
import fs from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const authClient = new OAuth2Client();

// Load service account credentials from file or env var
function tryParseJSON(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function extractField(raw, field) {
  const re = new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`, 's');
  const m = raw.match(re);
  return m ? m[1] : null;
}

function getServiceAccountCredentials() {
  const filePath = join(__dirname, 'service-account.json');
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }
  const envVar = process.env.SERVICE_ACCOUNT_JSON;
  if (envVar) {
    // Try parsing as plain JSON first
    let parsed = tryParseJSON(envVar);
    if (parsed) return parsed;

    // Try parsing as base64 if it fails
    try {
      const decoded = Buffer.from(envVar, 'base64').toString('utf-8').replace(/\0/g, '');
      parsed = tryParseJSON(decoded);
      if (parsed) return parsed;
    } catch {}

    // Fallback: extract fields with regex (handles corrupted base64 with trailing garbage)
    const decoded = envVar.includes('{') ? envVar : Buffer.from(envVar, 'base64').toString('utf-8');
    const project_id = extractField(decoded, 'project_id');
    const client_email = extractField(decoded, 'client_email');
    let private_key = extractField(decoded, 'private_key');
    if (private_key) private_key = private_key.replace(/\\n/g, '\n');
    if (project_id && client_email && private_key) {
      return { project_id, client_email, private_key };
    }
  }
  throw new Error('Service account not found. Set service-account.json or SERVICE_ACCOUNT_JSON env var.');
}

// Send a message to a Google Chat space using the Chat API
async function sendChatMessage(spaceName, text) {
  const key = getServiceAccountCredentials();
  const jwtClient = new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: ['https://www.googleapis.com/auth/chat.bot'],
  });
  await jwtClient.authorize();

  const url = `https://chat.googleapis.com/v1/${spaceName}/messages`;
  await jwtClient.request({
    url,
    method: 'POST',
    data: { text },
  });
  console.log(`[Chat] Message sent to space: ${spaceName}`);
}

// Download a Google Chat attachment using the service account
async function downloadChatAttachment(sourceUrl, outputPath) {
  const key = getServiceAccountCredentials();
  const jwtClient = new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: ['https://www.googleapis.com/auth/chat.bot'],
  });

  await jwtClient.authorize();
  const response = await jwtClient.request({ url: sourceUrl, responseType: 'arraybuffer' });

  const buffer = Buffer.from(response.data);
  fs.writeFileSync(outputPath, buffer);
  return outputPath;
}

/**
 * Process the user's question message, optionally with attached images/videos.
 */
async function processMessage(question, attachments, senderName, senderId, spaceName) {
  const tempDir = join(__dirname, 'temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  // 1. Find relevant docs via RAG
  let relevantFiles = [];
  if (question && question.trim()) {
    const queryEmbedding = await generateEmbedding(question);
    const matchedFiles = await searchSimilarFiles(queryEmbedding, 3);
    relevantFiles = matchedFiles.filter(f => f.score >= 0.2);
  }

  // 2. Process attachments (images/videos) uploaded by the user in Chat
  const mediaParts = [];
  const tempPaths = [];

  if (attachments && attachments.length > 0) {
    for (const att of attachments) {
      if (!att.sourceUrl) continue;
      const ext = att.contentType?.split('/')[1] || 'file';
      const tempPath = join(tempDir, `chat_${Date.now()}_${att.contentName || 'file'}.${ext}`);
      tempPaths.push(tempPath);

      console.log(`[Chat] Downloading attachment: ${att.contentName} (${att.contentType})`);
      await downloadChatAttachment(att.sourceUrl, tempPath);

      console.log(`[Chat] Preparing media for Gemini...`);
      const part = await prepareMediaPart(tempPath, att.contentType);
      mediaParts.push(part);
    }
  }

  try {
    // 3. Generate answer using text + media context
    const start = Date.now();
    const userQuestion = question?.trim() || 'Analiza esta imagen o video y dame información relevante.';
    const answer = await answerQuestion(userQuestion, relevantFiles, mediaParts);
    console.log(`[Chat] Gemini answer took ${Date.now() - start}ms`);

    // 4. Save to chat logs
    const sourceNames = relevantFiles.map(f => `${f.name} (Similitud: ${Math.round(f.score * 100)}%)`);
    if (mediaParts.length > 0) {
      sourceNames.push(...mediaParts.map((_, i) => `Archivo adjunto ${i + 1}`));
    }
    await logChat({
      platform: 'google-chat',
      userId: senderId,
      userName: senderName,
      question: userQuestion + (attachments?.length ? ` [${attachments.length} archivo(s) adjunto(s)]` : ''),
      answer: answer,
      sources: sourceNames
    });

    // 5. Build response text
    let responseText = `${answer}`;
    if (relevantFiles.length > 0) {
      responseText += `\n\nFuentes consultadas:\n`;
      relevantFiles.forEach(f => {
        responseText += `- ${f.name} (Relevancia: ${Math.round(f.score * 100)}%)\n`;
      });
    }
    if (mediaParts.length > 0 && relevantFiles.length === 0) {
      responseText += `\n\nNota: No encontré información específica en los manuales de Drive relacionada con lo que enviaste.`;
    }

    return { text: responseText };
  } finally {
    // Clean up temp files
    for (const p of tempPaths) {
      try { fs.unlinkSync(p); } catch {}
    }
  }
}

/**
 * Express middleware to verify the JWT signature of incoming Google Chat requests.
 */
export async function verifyGoogleChatToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.warn('Authorization header missing or incorrect format.');
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid token format' });
  }

  const token = authHeader.substring(7);
  const projectNumber = process.env.GOOGLE_CHAT_PROJECT_NUMBER;

  // If project number is not set, bypass verification for easy development/testing
  if (!projectNumber || projectNumber === 'your_project_number_here') {
    console.warn('GOOGLE_CHAT_PROJECT_NUMBER not configured. Webhook JWT signature verification bypassed.');
    return next();
  }

  try {
    const ticket = await authClient.verifyIdToken({ idToken: token });
    const payload = ticket.getPayload();

    console.log('[Chat] JWT iss:', payload.iss, 'aud:', payload.aud, 'email_verified:', payload.email_verified);

    // Google Chat sends user ID tokens with iss=https://accounts.google.com
    // and aud = our bot URL. Check email_verified and valid issuer.
    const validIssuers = ['https://accounts.google.com', 'accounts.google.com'];
    if (!validIssuers.includes(payload.iss)) {
      console.warn('[Chat] Invalid issuer:', payload.iss);
      return res.status(401).json({ error: 'Unauthorized: Invalid issuer' });
    }

    if (!payload.email_verified) {
      console.warn('[Chat] Email not verified');
      return res.status(401).json({ error: 'Unauthorized: Email not verified' });
    }

    console.log('[Chat] JWT verification successful, user:', payload.email);
    req.googleChatPayload = payload;
    return next();
  } catch (error) {
    console.error('JWT validation error:', error.message, error.stack);
    return res.status(401).json({ error: 'Unauthorized: Token validation failed' });
  }
}

/**
 * Process a message event from Google Chat.
 */
export async function handleChatMessage(eventBody) {
  // Workspace Add-on format (new): chat.messagePayload.message, chat.user
  const chatData = eventBody.chat;
  if (chatData?.messagePayload?.message) {
    const msg = chatData.messagePayload.message;
    const space = chatData.messagePayload.space;
    const user = chatData.user;
    const spaceName = space?.name;

    const question = msg.text || '';
    const attachments = msg.attachment || msg.attachments || [];
    const senderName = user?.displayName || 'Usuario de Google Chat';
    const senderId = user?.name || 'unknown';

    console.log(`[Google Chat] Message from ${senderName}: "${question.substring(0, 100)}" with ${attachments.length} attachment(s), space: ${spaceName}`);

    // Process synchronously: return answer directly from webhook
    if (question.trim() || attachments.length > 0) {
      try {
        const result = await processMessage(question, attachments, senderName, senderId);
        if (result && result.text) {
          return result;
        }
      } catch (err) {
        console.error('[Chat] Error processing message:', err);
        return { text: `❌ Error al procesar tu consulta: ${err.message}` };
      }
    }

    return { text: '¡Hola! Soy tu Asistente de Soporte Técnico. ¿En qué puedo ayudarte?' };
  }

  // Legacy Chat API format: type, message, space, user
  const { type, message, space, user } = eventBody;
  if (type) {
    console.log('[Chat] Legacy event type:', type, 'user:', user?.displayName || user?.email || 'unknown');

    if (type === 'ADDED_TO_SPACE') {
      const spaceType = space?.type === 'DM' ? 'Direct Message' : 'Space';
      console.log(`Bot added to space: ${space?.name} (${spaceType})`);
      return {
        text: `¡Hola! Soy tu Asistente de Soporte Técnico.
He sido creado para ayudarte a resolver problemas en nuestras máquinas.

Puedes enviarme:
• Una descripción del problema
• Una foto del error o la máquina
• Un video mostrando el inconveniente

Yo analizaré todo junto con los manuales para darte una solución detallada.`
      };
    }

    if (type === 'MESSAGE') {
      const question = message?.text || '';
      const attachments = message?.attachment || message?.attachments || [];
      const senderName = user?.displayName || 'Usuario de Google Chat';
      const senderId = user?.name || 'unknown';

      console.log(`[Google Chat] Message from ${senderName}: "${question.substring(0, 100)}"`);

      if (!question.trim() && attachments.length === 0) {
        return { text: 'No he recibido ningún texto ni archivo. ¿En qué puedo ayudarte?' };
      }

      try {
        return await processMessage(question, attachments, senderName, senderId);
      } catch (error) {
        console.error('[Google Chat] Error handling message event:', error);
        return {
          text: `❌ Lo siento, ocurrió un error al procesar tu solicitud: ${error.message}. Por favor, avisa al administrador.`
        };
      }
    }
  }

  // Unrecognized event
  console.log('[Chat] Unrecognized event, keys:', Object.keys(eventBody));
  return { text: 'Evento recibido. Gracias.' };
}
