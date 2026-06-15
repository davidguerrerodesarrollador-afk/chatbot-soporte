import sqlite3 from 'sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbDir = join(__dirname, 'data');
const dbPath = join(dbDir, 'bot.db');

// Ensure data directory exists
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new sqlite3.Database(dbPath);

// Helper to run query with promise
const run = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
};

// Helper to get single row
const get = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

// Helper to get all rows
const all = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

// Initialize database tables
export async function initDb() {
  await run(`
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      modified_time TEXT NOT NULL,
      size INTEGER NOT NULL,
      summary TEXT NOT NULL,
      embedding TEXT NOT NULL,
      synced_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS chat_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      user_id TEXT,
      user_name TEXT,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      sources TEXT,
      timestamp TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS login_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT NOT NULL,
      success INTEGER NOT NULL,
      timestamp TEXT NOT NULL
    )
  `);
}

// Save or update synced file
export async function saveFile({ id, name, mimeType, modifiedTime, size, summary, embedding }) {
  const syncedAt = new Date().toISOString();
  const embeddingStr = JSON.stringify(embedding);
  await run(
    `INSERT OR REPLACE INTO files (id, name, mime_type, modified_time, size, summary, embedding, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, mimeType, modifiedTime, size, summary, embeddingStr, syncedAt]
  );
}

// Delete file
export async function deleteFile(id) {
  await run('DELETE FROM files WHERE id = ?', [id]);
}

// Get file by ID
export async function getFile(id) {
  const file = await get('SELECT * FROM files WHERE id = ?', [id]);
  if (file) {
    file.embedding = JSON.parse(file.embedding);
  }
  return file;
}

// Get all files
export async function getAllFiles() {
  const files = await all('SELECT id, name, mime_type, modified_time, size, synced_at FROM files ORDER BY name ASC');
  return files;
}

// Get all files with summaries (used for debugging/admin panel)
export async function getAllFilesWithSummaries() {
  const files = await all('SELECT id, name, mime_type, modified_time, size, summary, synced_at FROM files ORDER BY name ASC');
  return files;
}

// Log chat message
export async function logChat({ platform, userId, userName, question, answer, sources }) {
  const timestamp = new Date().toISOString();
  const sourcesStr = JSON.stringify(sources || []);
  await run(
    `INSERT INTO chat_logs (platform, user_id, user_name, question, answer, sources, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [platform, userId, userName, question, answer, sourcesStr, timestamp]
  );
}

// Log login attempt (for security auditing)
export async function logLoginAttempt(ip, success) {
  const timestamp = new Date().toISOString();
  await run('INSERT INTO login_attempts (ip, success, timestamp) VALUES (?, ?, ?)', [ip, success ? 1 : 0, timestamp]);
}

// Get failed login attempts in last 15 minutes from an IP
export async function getRecentFailedAttempts(ip) {
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const rows = await all('SELECT COUNT(*) as count FROM login_attempts WHERE ip = ? AND success = 0 AND timestamp > ?', [ip, since]);
  return rows[0].count;
}

// Get chat logs
export async function getChatLogs() {
  const logs = await all('SELECT * FROM chat_logs ORDER BY id DESC LIMIT 100');
  return logs.map(l => ({
    ...l,
    sources: JSON.parse(l.sources || '[]')
  }));
}

// Cosine Similarity Calculator
function cosineSimilarity(vecA, vecB) {
  let dotProduct = 0.0;
  let normA = 0.0;
  let normB = 0.0;
  
  if (vecA.length !== vecB.length) {
    return 0; // Dimension mismatch
  }
  
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Search similar files based on query embedding
export async function searchSimilarFiles(queryEmbedding, limit = 3) {
  const allFiles = await all('SELECT id, name, summary, embedding FROM files');
  const scoredFiles = allFiles.map(file => {
    const fileEmbedding = JSON.parse(file.embedding);
    const score = cosineSimilarity(queryEmbedding, fileEmbedding);
    return {
      id: file.id,
      name: file.name,
      summary: file.summary,
      score: score
    };
  });

  // Sort descending by score
  scoredFiles.sort((a, b) => b.score - a.score);

  // Return top items
  return scoredFiles.slice(0, limit);
}
