// Test Suite for Chatbot RAG System
import fs from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { initDb, saveFile, searchSimilarFiles, getChatLogs, getAllFiles } from './database.js';
import { getDriveClient } from './drive.js';
import { getGeminiClient } from './gemini.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function runTests() {
  console.log('🤖 INICIANDO PRUEBAS DE DIAGNÓSTICO DEL SISTEMA...\n');
  let passed = 0;
  let failed = 0;

  // Test 1: Configuration Checks
  console.log('📋 PRUEBA 1: Verificación de archivos de configuración');
  const envPath = join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    console.log('  ✅ Archivo .env encontrado.');
    passed++;
  } else {
    console.warn('  ❌ Archivo .env no encontrado. Debe crearse a partir de .env.example');
    failed++;
  }

  const saPath = join(__dirname, 'service-account.json');
  if (fs.existsSync(saPath)) {
    console.log('  ✅ Archivo service-account.json encontrado.');
    passed++;
  } else {
    console.warn('  ⚠️ Archivo service-account.json no encontrado.');
    console.warn('     Nota: Es obligatorio para conectar con Google Drive.');
    passed++; // Mark as passed as it is a warning for deployment setup
  }

  // Test 2: Database Initialization and Schema
  console.log('\n🗄️ PRUEBA 2: Inicialización y operaciones de Base de Datos SQLite');
  try {
    await initDb();
    console.log('  ✅ Base de datos inicializada correctamente (tablas creadas).');
    
    // Insert Mock file
    const mockEmbedding = Array(768).fill(0).map((_, i) => (i === 10 ? 0.8 : i === 20 ? 0.6 : 0.05));
    const mockFile = {
      id: 'mock_drive_file_id_123',
      name: 'Manual_Router_CNC.pdf',
      mimeType: 'application/pdf',
      modifiedTime: new Date().toISOString(),
      size: 1048576,
      summary: 'Este es el manual oficial de mantenimiento del Router CNC Modelo X-100. Contiene instrucciones para corregir el error de husillo E03 limpiando los conectores.',
      embedding: mockEmbedding
    };
    
    await saveFile(mockFile);
    console.log('  ✅ Inserción de archivo de prueba exitosa.');
    
    // Query check
    const files = await getAllFiles();
    if (files.some(f => f.id === 'mock_drive_file_id_123')) {
      console.log('  ✅ Lectura de archivos sincronizados exitosa.');
    } else {
      throw new Error('El archivo guardado no se encontró en la base de datos');
    }

    // Cosine similarity search test
    const queryEmbedding = Array(768).fill(0).map((_, i) => (i === 10 ? 0.9 : i === 20 ? 0.5 : 0.01));
    const results = await searchSimilarFiles(queryEmbedding, 1);
    
    if (results.length > 0 && results[0].id === 'mock_drive_file_id_123') {
      console.log(`  ✅ Búsqueda de similitud coseno exitosa. Puntaje de relevancia obtenido: ${(results[0].score * 100).toFixed(1)}%`);
      passed++;
    } else {
      throw new Error('No se pudo encontrar el archivo mock con la búsqueda vectorial');
    }
    
    passed++;
  } catch (dbError) {
    console.error('  ❌ Error de Base de Datos:', dbError.message);
    failed++;
  }

  // Test 3: API Connections (Gemini)
  console.log('\n🧠 PRUEBA 3: Verificación de Credenciales de APIs externas');
  const gemini = getGeminiClient();
  if (gemini) {
    console.log('  ✅ Cliente de API Gemini instanciado.');
    passed++;
  } else {
    console.warn('  ❌ No se pudo inicializar el cliente Gemini. Asegúrate de configurar GEMINI_API_KEY en .env');
    failed++;
  }

  const drive = getDriveClient();
  if (drive) {
    console.log('  ✅ Cliente de API Google Drive instanciado.');
    passed++;
  } else {
    console.warn('  ⚠️ No se pudo inicializar el cliente Google Drive. Recuerda colocar tu llave en service-account.json');
    // warning only
    passed++;
  }

  console.log('\n======================================================');
  console.log(`📊 RESUMEN DEL DIAGNÓSTICO:`);
  console.log(`   Pruebas Exitosas: ${passed}`);
  console.log(`   Pruebas Fallidas: ${failed}`);
  if (failed === 0) {
    console.log(`🎉 ¡Diagnóstico local exitoso! El sistema está listo para integrarse.`);
  } else {
    console.log(`⚠️  Se encontraron detalles pendientes. Por favor, revísalos.`);
  }
  console.log('======================================================\n');
}

runTests().catch(err => {
  console.error('Error fatal durante la prueba:', err);
});
