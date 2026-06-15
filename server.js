import express from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import cron from 'node-cron';
import dotenv from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

// Import our modules
import { initDb, getAllFilesWithSummaries, getChatLogs, logChat, searchSimilarFiles, logLoginAttempt, getRecentFailedAttempts } from './database.js';
import { syncFolder, getSyncStatus } from './sync.js';
import { verifyGoogleChatToken, handleChatMessage } from './chat.js';
import { generateEmbedding, answerQuestion, prepareMediaPart } from './gemini.js';

const upload = multer({ dest: join(dirname(fileURLToPath(import.meta.url)), 'temp', 'uploads') });

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Force HTTPS in production
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && !req.secure && req.headers['x-forwarded-proto'] !== 'https') {
    return res.redirect(`https://${req.headers.host}${req.url}`);
  }
  next();
});

// Restrict CORS to same origin
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin && origin !== `https://${host}` && origin !== `http://${host}`) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// Express Configuration
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// Rate limiters
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Demasiados intentos de inicio de sesión. Intenta de nuevo en 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Demasiadas solicitudes. Intenta de nuevo más tarde.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Admin Dashboard Password Protection Middleware
function verifyAdmin(req, res, next) {
  const adminPassword = req.headers['x-admin-password'] || req.query.password;
  const configuredPassword = process.env.ADMIN_PASSWORD || 'admin123';
  
  if (adminPassword === configuredPassword) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized: Invalid admin password' });
}

// ----------------------------------------------------
// Google Chat Webhook Endpoint
// ----------------------------------------------------
app.post('/api/chat', verifyGoogleChatToken, async (req, res) => {
  try {
    const response = await handleChatMessage(req.body);
    if (response) {
      return res.json(response);
    }
    return res.status(200).send();
  } catch (error) {
    console.error('[Server] Error handling Google Chat webhook:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ----------------------------------------------------
// Admin Dashboard API Endpoints
// ----------------------------------------------------

// Verify password
app.post('/api/admin/verify', loginLimiter, async (req, res) => {
  const { password } = req.body;
  const configuredPassword = process.env.ADMIN_PASSWORD || 'admin123';
  const ip = req.ip || req.connection.remoteAddress;
  
  if (password === configuredPassword) {
    await logLoginAttempt(ip, true);
    return res.json({ success: true });
  }
  
  await logLoginAttempt(ip, false);
  return res.status(401).json({ error: 'Contraseña incorrecta' });
});

// Get bot status and configuration info
app.get('/api/admin/status', apiLimiter, verifyAdmin, async (req, res) => {
  try {
    const syncStatus = getSyncStatus();
    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID || '';
    
    // Get simple counts from DB
    const files = await getAllFilesWithSummaries();
    const logs = await getChatLogs();
    
    res.json({
      folderId: folderId.includes('your_drive_folder_id') ? 'No configurada' : folderId,
      filesCount: files.length,
      logsCount: logs.length,
      sync: syncStatus
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get synced files list
app.get('/api/admin/files', apiLimiter, verifyAdmin, async (req, res) => {
  try {
    const files = await getAllFilesWithSummaries();
    res.json(files);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get chat logs
app.get('/api/admin/logs', apiLimiter, verifyAdmin, async (req, res) => {
  try {
    const logs = await getChatLogs();
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Trigger manual sync
app.post('/api/admin/sync', apiLimiter, verifyAdmin, async (req, res) => {
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!folderId || folderId.includes('your_drive_folder_id')) {
    return res.status(400).json({ error: 'La ID de la carpeta de Google Drive no está configurada en el archivo .env' });
  }

  try {
    // Run sync in the background so request doesn't timeout for large drives
    syncFolder(folderId)
      .then(() => console.log('[Server] Background sync finished successfully'))
      .catch((err) => console.error('[Server] Background sync failed:', err));
    
    res.json({ message: 'Sincronización iniciada en segundo plano' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Playground chat testing endpoint
app.post('/api/admin/playground', apiLimiter, verifyAdmin, async (req, res) => {
  const { question } = req.body;
  if (!question) {
    return res.status(400).json({ error: 'La pregunta es requerida' });
  }

  try {
    // RAG Flow
    const queryEmbedding = await generateEmbedding(question);
    const matchedFiles = await searchSimilarFiles(queryEmbedding, 3);
    const relevantFiles = matchedFiles.filter(f => f.score >= 0.2);
    const answer = await answerQuestion(question, relevantFiles);

    const sourceNames = relevantFiles.map(f => `${f.name} (Similitud: ${Math.round(f.score * 100)}%)`);
    
    // Save playground logs separately
    await logChat({
      platform: 'web-playground',
      userId: 'admin',
      userName: 'Administrador (Playground)',
      question: question,
      answer: answer,
      sources: sourceNames
    });

    res.json({
      answer: answer,
      sources: relevantFiles.map(f => ({ name: f.name, score: f.score }))
    });
  } catch (error) {
    console.error('[Server] Playground error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Playground test endpoint with media (images/videos)
app.post('/api/admin/test-media', apiLimiter, verifyAdmin, upload.single('file'), async (req, res) => {
  const question = req.body.question || '';
  const file = req.file;

  if (!file && !question.trim()) {
    return res.status(400).json({ error: 'Debes proporcionar texto, un archivo (imagen/video), o ambos.' });
  }

  const tempDir = join(__dirname, 'temp', 'uploads');

  try {
    // 1. Search RAG if there's text
    let relevantFiles = [];
    if (question.trim()) {
      const queryEmbedding = await generateEmbedding(question);
      const matchedFiles = await searchSimilarFiles(queryEmbedding, 3);
      relevantFiles = matchedFiles.filter(f => f.score >= 0.2);
    }

    // 2. Prepare media part (inlineData for images, fileData for videos)
    const mediaParts = [];
    if (file) {
      const part = await prepareMediaPart(file.path, file.mimetype);
      mediaParts.push(part);
    }

    // 3. Generate answer
    const userQuestion = question.trim() || 'Analiza este archivo y dame información relevante.';
    const answer = await answerQuestion(userQuestion, relevantFiles, mediaParts);

    const sourceNames = relevantFiles.map(f => `${f.name} (Similitud: ${Math.round(f.score * 100)}%)`);

    res.json({
      answer,
      sources: relevantFiles.map(f => ({ name: f.name, score: f.score })),
      mediaProcessed: !!file
    });

  } catch (error) {
    console.error('[Server] Test-media error:', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (file) {
      try { fs.unlinkSync(file.path); } catch {}
    }
  }
});

// ----------------------------------------------------
// Scheduler: Daily Sync at 1:00 AM
// ----------------------------------------------------
cron.schedule('0 1 * * *', async () => {
  console.log('[Scheduler] Executing scheduled daily sync at 1:00 AM...');
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (folderId && !folderId.includes('your_drive_folder_id')) {
    try {
      await syncFolder(folderId);
      console.log('[Scheduler] Scheduled daily sync finished successfully');
    } catch (err) {
      console.error('[Scheduler] Scheduled daily sync failed:', err);
    }
  } else {
    console.warn('[Scheduler] Skipping daily sync: GOOGLE_DRIVE_FOLDER_ID not properly configured');
  }
});

// Initialize server
async function startServer() {
  try {
    console.log('[Server] Initializing SQLite database...');
    await initDb();
    
    app.listen(PORT, () => {
      console.log(`\n======================================================`);
      console.log(`🚀 Chatbot Servidor corriendo en puerto: ${PORT}`);
      console.log(`🖥️  Panel de Admin disponible en: http://localhost:${PORT}`);
      console.log(`🤖 Google Chat Webhook en: http://localhost:${PORT}/api/chat`);
      console.log(`======================================================\n`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

startServer();
