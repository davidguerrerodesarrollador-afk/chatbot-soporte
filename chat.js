import { OAuth2Client, JWT } from 'google-auth-library';
import { generateEmbedding, answerQuestion, prepareMediaPart } from './gemini.js';
import { searchSimilarFiles, logChat } from './database.js';
import { downloadFile } from './drive.js';
import fs from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const authClient = new OAuth2Client();

// Idempotency cache: Chat retries webhook deliveries, which would otherwise
// produce duplicate answers. Entries expire after 10 minutes.
const DEDUPE_TTL_MS = 10 * 60 * 1000;
const processedMessages = new Map();

function pruneProcessedMessages() {
  const cutoff = Date.now() - DEDUPE_TTL_MS;
  for (const [key, ts] of processedMessages) {
    if (ts < cutoff) processedMessages.delete(key);
  }
}

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

// Create an authorized JWT client for Google Chat API calls
async function getJwtClient() {
  const key = getServiceAccountCredentials();
  const jwtClient = new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: ['https://www.googleapis.com/auth/chat.bot'],
  });
  await jwtClient.authorize();
  return jwtClient;
}

// Download an attachment that was uploaded directly into the Chat message
// (source: UPLOADED_CONTENT). The bytes are fetched via the Chat media API:
//   GET https://chat.googleapis.com/v1/media/{attachmentDataRef.resourceName}?alt=media
// The `downloadUri` present in the payload is intended for humans only and
// must not be used by apps.
async function downloadUploadedAttachment(resourceName, outputPath) {
  const jwtClient = await getJwtClient();
  const url = `https://chat.googleapis.com/v1/media/${resourceName}?alt=media`;
  const response = await jwtClient.request({ url, responseType: 'arraybuffer' });

  fs.writeFileSync(outputPath, Buffer.from(response.data));
  return outputPath;
}

// Pick a file extension for the temp file based on the MIME type and original name
function resolveExtension(att, fallback) {
  const type = (att.contentType || '').toLowerCase();
  const map = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp',
    'image/gif': 'gif', 'image/heic': 'heic',
    'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
    'video/x-matroska': 'mkv', 'video/3gpp': '3gp',
    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a',
    'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/wav': 'wav',
    'audio/x-wav': 'wav', 'audio/webm': 'weba', 'audio/flac': 'flac',
  };
  if (map[type]) return map[type];
  if (type.includes('/')) return type.split('/')[1].split(';')[0];
  // Last resort: use the original file name's extension if it has one
  const nameExt = att.contentName?.match(/\.([a-z0-9]{2,5})$/i);
  return nameExt ? nameExt[1].toLowerCase() : fallback;
}

// Google Chat has no documented MIME type for voice messages (commonly .m4a/AAC).
// Normalize the ones we know so the Gemini File API accepts them.
function normalizeAudioMimeType(mimeType) {
  const type = (mimeType || '').toLowerCase();
  if (!type.startsWith('audio/')) return mimeType;
  if (['audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/aac'].includes(type)) return 'audio/mp4';
  if (type === 'audio/x-wav') return 'audio/wav';
  return mimeType;
}

// Sanitize a filename for use in a temp path
function safeFileName(name, fallback) {
  const cleaned = (name || '')
    .replace(/[^\w.\-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 80);
  return cleaned || fallback;
}

/**
 * Process the user's question message, optionally with attached images/videos.
 */
async function processMessage(question, attachments, senderName, senderId, spaceName) {
  // Send "Procesando información..." immediately via Chat API
  if (spaceName) {
    try {
      await sendChatMessage(spaceName, '🔍 Procesando información...');
    } catch (e) {
      console.log('[Chat] Failed to send initial message:', e.message);
    }
  }

  const tempDir = join(__dirname, 'temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  // 1. Find relevant docs via RAG
  let relevantFiles = [];
  if (question && question.trim()) {
    const queryEmbedding = await generateEmbedding(question);
    const matchedFiles = await searchSimilarFiles(queryEmbedding, 3);
    relevantFiles = matchedFiles.filter(f => f.score >= 0.2);
  }

  // 2. Process attachments (images/videos/audio) uploaded by the user in Chat
  const mediaParts = [];
  const tempPaths = [];
  const failedAttachments = [];

  if (attachments && attachments.length > 0) {
    for (const att of attachments) {
      // A Chat attachment is either uploaded directly into the message
      // (attachmentDataRef) or a Drive file shared into the space (driveDataRef).
      const uploadedResource = att.attachmentDataRef?.resourceName;
      const driveFileId = att.driveDataRef?.driveFileId;

      if (!uploadedResource && !driveFileId) {
        console.warn(`[Chat] Attachment "${att.contentName || 'sin nombre'}" has no downloadable reference (source=${att.source}). Skipping.`);
        continue;
      }

      const isAudio = (att.contentType || '').toLowerCase().startsWith('audio/');
      const ext = resolveExtension(att, isAudio ? 'm4a' : 'bin');
      const baseName = safeFileName(att.contentName, 'adjunto');
      const tempPath = join(tempDir, `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${baseName}.${ext}`);
      tempPaths.push(tempPath);

      try {
        if (uploadedResource) {
          console.log(`[Chat] Downloading Chat attachment: ${att.contentName} (${att.contentType})`);
          await downloadUploadedAttachment(uploadedResource, tempPath);
        } else {
          console.log(`[Chat] Downloading Drive attachment: ${att.contentName} (${att.contentType})`);
          await downloadFile(driveFileId, tempPath);
        }

        const mimeType = normalizeAudioMimeType(att.contentType);
        console.log(`[Chat] Preparing media for Gemini (${mimeType})...`);
        const part = await prepareMediaPart(tempPath, mimeType);
        mediaParts.push(part);
      } catch (err) {
        console.error(`[Chat] Failed to process attachment "${att.contentName || 'sin nombre'}":`, err.message);
        failedAttachments.push(att.contentName || 'archivo sin nombre');
      }
    }
  }

  // 2.5 If media attached but no docs found by text, use media description to search
  if (mediaParts.length > 0 && relevantFiles.length === 0) {
    try {
      const descAnswer = await answerQuestion('Describe en detalle el contenido de este archivo. Genera palabras clave específicas.', [], mediaParts, { describeOnly: true });
      const descEmbedding = await generateEmbedding(descAnswer);
      const descMatchedFiles = await searchSimilarFiles(descEmbedding, 3);
      relevantFiles = descMatchedFiles.filter(f => f.score >= 0.2);
    } catch (e) {
      console.log('[Chat] Media description search failed:', e.message);
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
      const top = relevantFiles[0];
      const fileUrl = `https://drive.google.com/file/d/${top.id}/view`;
      responseText += `\n\nEl documento que más concuerda con tu consulta es: [${top.name}](${fileUrl})`;
    }
    if (mediaParts.length > 0 && relevantFiles.length === 0) {
      responseText += `\n\nNota: No encontré información específica en la documentación de Drive relacionada con lo que enviaste. Te recomiendo contactar al área responsable.`;
    } else if (attachments.length > 0 && mediaParts.length === 0 && failedAttachments.length === 0) {
      responseText += `\n\n⚠️ Recibí tu mensaje pero no pude descargar los archivos adjuntos. Intenta de nuevo.`;
    }
    if (failedAttachments.length > 0) {
      responseText += `\n\n⚠️ No pude procesar ${failedAttachments.length} archivo(s): ${failedAttachments.join(', ')}.`;
    }

    // Send answer via Chat API
    if (spaceName) {
      try {
        await sendChatMessage(spaceName, responseText);
      } catch (e) {
        console.log('[Chat] Failed to send answer:', e.message);
      }
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
    const attachments = msg.attachment || [];
    const senderName = user?.displayName || 'Usuario de Google Chat';
    const senderId = user?.name || 'unknown';

    console.log(`[Google Chat] Message from ${senderName}: "${question.substring(0, 100)}" with ${attachments.length} attachment(s), space: ${spaceName}`);

    // Google Chat may retry the webhook for the same message. Use the message
    // resource name as an idempotency key to avoid duplicate answers.
    const dedupeKey = msg.name || `${spaceName}|${senderId}|${msg.createTime}`;
    if (dedupeKey && processedMessages.has(dedupeKey)) {
      console.log('[Google Chat] Duplicate message ignored:', dedupeKey);
      return null;
    }

    // Acknowledge immediately (Chat apps have a 30s synchronous timeout) and
    // process asynchronously, replying via the Chat API when done.
    if (question.trim() || attachments.length > 0) {
      if (dedupeKey) {
        processedMessages.set(dedupeKey, Date.now());
        pruneProcessedMessages();
      }
      processMessage(question, attachments, senderName, senderId, spaceName)
        .catch(err => console.error('[Chat] Async error:', err));
    }

    return null;
  }

  // Legacy Chat API format: type, message, space, user
  const { type, message, space, user } = eventBody;
  if (type) {
    console.log('[Chat] Legacy event type:', type, 'user:', user?.displayName || user?.email || 'unknown');

    if (type === 'ADDED_TO_SPACE') {
      const spaceType = space?.type === 'DM' ? 'Direct Message' : 'Space';
      console.log(`Bot added to space: ${space?.name} (${spaceType})`);
      return {
        text: `¡Hola! Soy tu Asistente de Consulta Documental.
Respondo únicamente con base en los documentos que el administrador ha cargado.

Puedes mandarme:
• Una consulta sobre esos documentos
• Una foto, video o nota de voz para analizarla

Si la respuesta no está en los documentos, te lo diré.`
      };
    }

    if (type === 'MESSAGE') {
      const question = message?.text || '';
      const attachments = message?.attachment || [];
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
