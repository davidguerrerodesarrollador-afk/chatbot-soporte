import { google } from 'googleapis';
import fs from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let driveClient = null;

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

    const decoded = envVar.includes('{') ? envVar : Buffer.from(envVar, 'base64').toString('utf-8');
    const project_id = extractField(decoded, 'project_id');
    const client_email = extractField(decoded, 'client_email');
    let private_key = extractField(decoded, 'private_key');
    if (private_key) private_key = private_key.replace(/\\n/g, '\n');
    if (project_id && client_email && private_key) {
      return { project_id, client_email, private_key };
    }
  }
  return null;
}

// Initialize Google Drive Client using the Service Account
export function getDriveClient() {
  if (driveClient) return driveClient;

  const credentials = getServiceAccountCredentials();
  if (!credentials) {
    console.warn('⚠️ Service Account not found. Set service-account.json or SERVICE_ACCOUNT_JSON env var.');
    return null;
  }

  try {
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });
    
    driveClient = google.drive({ version: 'v3', auth });
    return driveClient;
  } catch (error) {
    console.error('Failed to initialize Google Drive client:', error);
    return null;
  }
}

/**
 * List all files in the configured Google Drive folder.
 * @param {string} folderId The Google Drive Folder ID.
 * @returns {Promise<Array>} List of file metadata objects.
 */
export async function listFilesInFolder(folderId) {
  const drive = getDriveClient();
  if (!drive) {
    throw new Error('Google Drive client is not initialized. Please verify service-account.json.');
  }

  if (!folderId || folderId.includes('your_drive_folder_id')) {
    throw new Error('Google Drive Folder ID is not configured in .env');
  }

  try {
    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id, name, mimeType, modifiedTime, size)',
      pageSize: 1000,
    });
    
    return response.data.files || [];
  } catch (error) {
    console.error(`Error listing files in folder ${folderId}:`, error);
    throw error;
  }
}

/**
 * Download a file from Google Drive to a local path.
 * @param {string} fileId The Google Drive File ID.
 * @param {string} outputPath The local destination path.
 * @returns {Promise<string>} The output path of the downloaded file.
 */
export async function downloadFile(fileId, outputPath) {
  const drive = getDriveClient();
  if (!drive) {
    throw new Error('Google Drive client is not initialized.');
  }

  try {
    // Ensure parent directory exists for the output file
    const outputDir = dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const dest = fs.createWriteStream(outputPath);
    const response = await drive.files.get(
      { fileId: fileId, alt: 'media' },
      { responseType: 'stream' }
    );

    return new Promise((resolve, reject) => {
      response.data
        .pipe(dest)
        .on('finish', () => {
          resolve(outputPath);
        })
        .on('error', (err) => {
          fs.unlink(outputPath, () => {}); // Clean up file on error
          reject(err);
        });
    });
  } catch (error) {
    console.error(`Error downloading file ${fileId}:`, error);
    throw error;
  }
}

/**
 * Export a Google Sheets file to CSV and save locally.
 * @param {string} fileId The Google Drive File ID.
 * @param {string} outputPath The local destination path (.csv).
 * @returns {Promise<string>} The output path of the exported file.
 */
export async function exportSheetsToCsv(fileId, outputPath) {
  const drive = getDriveClient();
  if (!drive) {
    throw new Error('Google Drive client is not initialized.');
  }

  try {
    const outputDir = dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const dest = fs.createWriteStream(outputPath);
    const response = await drive.files.export(
      { fileId, mimeType: 'text/csv' },
      { responseType: 'stream' }
    );

    return new Promise((resolve, reject) => {
      response.data
        .pipe(dest)
        .on('finish', () => {
          console.log(`[Drive] Exported Sheets file ${fileId} to CSV: ${outputPath}`);
          resolve(outputPath);
        })
        .on('error', (err) => {
          fs.unlink(outputPath, () => {});
          reject(err);
        });
    });
  } catch (error) {
    console.error(`Error exporting Sheets file ${fileId}:`, error);
    throw error;
  }
}
