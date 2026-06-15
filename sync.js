import { listFilesInFolder, downloadFile } from './drive.js';
import { generateSummary, generateEmbedding } from './gemini.js';
import { saveFile, deleteFile, getAllFiles } from './database.js';
import fs from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tempDir = join(__dirname, 'temp');

// Ensure temp directory exists
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

let isSyncing = false;
let lastSyncTime = null;
let lastSyncResult = null;

export function getSyncStatus() {
  return {
    isSyncing,
    lastSyncTime,
    lastSyncResult,
  };
}

/**
 * Sync the local database with the Google Drive folder contents.
 * @param {string} folderId The Google Drive Folder ID.
 * @returns {Promise<object>} The results of the sync operation.
 */
export async function syncFolder(folderId) {
  if (isSyncing) {
    throw new Error('A sync operation is already in progress.');
  }

  isSyncing = true;
  console.log(`[Sync] Starting sync for Drive folder: ${folderId}`);
  
  const results = {
    added: [],
    updated: [],
    deleted: [],
    failed: [],
    total: 0
  };

  try {
    // 1. List all files currently in Google Drive
    const driveFiles = await listFilesInFolder(folderId);
    results.total = driveFiles.length;

    // 2. List all files currently in the database
    const dbFiles = await getAllFiles();
    const dbFilesMap = new Map(dbFiles.map(f => [f.id, f]));
    const driveFilesMap = new Map(driveFiles.map(f => [f.id, f]));

    // 3. Process Deletions (files in DB but no longer in Drive)
    for (const dbFile of dbFiles) {
      if (!driveFilesMap.has(dbFile.id)) {
        console.log(`[Sync] File "${dbFile.name}" (ID: ${dbFile.id}) was deleted from Drive. Removing from database...`);
        await deleteFile(dbFile.id);
        results.deleted.push(dbFile.name);
      }
    }

    // 4. Process Additions and Modifications
    for (const driveFile of driveFiles) {
      const dbFile = dbFilesMap.get(driveFile.id);
      
      const isNew = !dbFile;
      const isUpdated = dbFile && new Date(driveFile.modifiedTime) > new Date(dbFile.modified_time);

      if (isNew || isUpdated) {
        const actionText = isNew ? 'new' : 'updated';
        console.log(`[Sync] Found ${actionText} file: "${driveFile.name}" (ID: ${driveFile.id}). Processing...`);

        const tempFilePath = join(tempDir, `${driveFile.id}_${driveFile.name}`);
        
        try {
          // Download file locally
          await downloadFile(driveFile.id, tempFilePath);
          
          // Generate summary using Gemini
          const summary = await generateSummary(tempFilePath, driveFile.mimeType, driveFile.name);
          
          // Generate embedding of the summary
          const embedding = await generateEmbedding(summary);
          
          // Save file details & embedding to DB
          await saveFile({
            id: driveFile.id,
            name: driveFile.name,
            mimeType: driveFile.mimeType,
            modifiedTime: driveFile.modifiedTime,
            size: parseInt(driveFile.size || '0', 10),
            summary: summary,
            embedding: embedding
          });

          if (isNew) {
            results.added.push(driveFile.name);
          } else {
            results.updated.push(driveFile.name);
          }

          console.log(`[Sync] Successfully indexed file: "${driveFile.name}"`);
        } catch (fileError) {
          console.error(`[Sync] Failed to process file "${driveFile.name}":`, fileError);
          results.failed.push({ name: driveFile.name, error: fileError.message });
        } finally {
          // Clean up local downloaded file
          if (fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath);
          }
        }
      }
    }

    lastSyncTime = new Date().toISOString();
    lastSyncResult = {
      success: true,
      addedCount: results.added.length,
      updatedCount: results.updated.length,
      deletedCount: results.deleted.length,
      failedCount: results.failed.length,
      errors: results.failed
    };

    console.log(`[Sync] Sync completed successfully. Added: ${results.added.length}, Updated: ${results.updated.length}, Deleted: ${results.deleted.length}, Failed: ${results.failed.length}`);
    return results;
  } catch (error) {
    console.error('[Sync] General sync error:', error);
    lastSyncTime = new Date().toISOString();
    lastSyncResult = {
      success: false,
      error: error.message
    };
    throw error;
  } finally {
    isSyncing = false;
    
    // Clean up temp directory leftovers if any
    try {
      const files = fs.readdirSync(tempDir);
      for (const file of files) {
        fs.unlinkSync(join(tempDir, file));
      }
    } catch (cleanError) {
      // Ignore cleanup error
    }
  }
}
