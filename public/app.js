// Dashboard Frontend Controller

let adminPassword = localStorage.getItem('adminPassword') || '';
let isSyncStatusPolling = false;
let allFiles = []; // Store files locally for filtering

// ----------------------------------------------------
// Initialization & Authentication
// ----------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  if (adminPassword) {
    verifyAndInit(adminPassword);
  } else {
    showLogin();
  }

  setupEventListeners();
});

function showLogin() {
  document.getElementById('login-overlay').classList.remove('hide');
  document.getElementById('app-container').classList.add('hide');
}

function hideLogin() {
  document.getElementById('login-overlay').classList.add('hide');
  document.getElementById('app-container').classList.remove('hide');
}

async function verifyAndInit(password) {
  try {
    const response = await fetch('/api/admin/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });

    if (response.ok) {
      adminPassword = password;
      localStorage.setItem('adminPassword', password);
      hideLogin();
      initDashboard();
    } else {
      showLogin();
      localStorage.removeItem('adminPassword');
      showLoginError('Contraseña guardada no válida. Ingrese de nuevo.');
    }
  } catch (error) {
    console.error('Error verifying connection:', error);
    showLoginError('No se pudo conectar con el servidor.');
  }
}

function showLoginError(msg) {
  const errEl = document.getElementById('login-error');
  errEl.textContent = msg;
  errEl.classList.remove('hide');
}

// ----------------------------------------------------
// Setup Global Event Listeners
// ----------------------------------------------------
function setupEventListeners() {
  // Login Form
  document.getElementById('login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const passwordInput = document.getElementById('admin-password').value;
    verifyAndInit(passwordInput);
  });

  // Logout
  document.getElementById('btn-logout').addEventListener('click', () => {
    localStorage.removeItem('adminPassword');
    adminPassword = '';
    showLogin();
  });

  // Tab Menu Switching
  const menuItems = document.querySelectorAll('.menu-item');
  menuItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const tabId = item.getAttribute('data-tab');
      switchTab(tabId);
    });
  });

  // Quick links in overview to switch tabs
  document.querySelectorAll('.view-all-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const tabId = link.getAttribute('data-go-tab');
      switchTab(tabId);
    });
  });

  // Sync Button
  document.getElementById('btn-sync-now').addEventListener('click', triggerSync);

  // Document Search Filter
  document.getElementById('doc-search').addEventListener('input', (e) => {
    filterDocuments(e.target.value);
  });

  // Modal close
  document.getElementById('btn-close-modal').addEventListener('click', () => {
    document.getElementById('summary-modal').classList.remove('active');
  });

  // Close modal when clicking background overlay
  document.getElementById('summary-modal').addEventListener('click', (e) => {
    if (e.target.id === 'summary-modal') {
      document.getElementById('summary-modal').classList.remove('active');
    }
  });

  // Chat Playgrounds Send Buttons
  document.getElementById('btn-mini-send').addEventListener('click', sendMiniChat);
  document.getElementById('mini-chat-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMiniChat();
  });

  document.getElementById('btn-play-send').addEventListener('click', sendFullChat);
  document.getElementById('play-chat-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendFullChat();
  });
}

function switchTab(tabId) {
  // Update sidebar classes
  document.querySelectorAll('.menu-item').forEach(item => {
    if (item.getAttribute('data-tab') === tabId) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });

  // Hide all views, show selected
  document.querySelectorAll('.tab-content').forEach(view => {
    if (view.id === tabId) {
      view.classList.remove('hide');
      view.classList.add('active');
    } else {
      view.classList.add('hide');
      view.classList.remove('active');
    }
  });

  // Set Page Title
  const titles = {
    'tab-overview': 'Panel de Control',
    'tab-documents': 'Directorio de Conocimiento',
    'tab-playground': 'Simulador RAG (Playground)',
    'tab-logs': 'Historial de Auditoría'
  };
  document.getElementById('page-title').textContent = titles[tabId] || 'Panel de Control';

  // Refresh tab-specific data when clicked
  if (tabId === 'tab-documents') loadDocuments();
  if (tabId === 'tab-logs') loadLogs();
  if (tabId === 'tab-overview') loadStatus();
}

// ----------------------------------------------------
// Dashboard API Data Fetching
// ----------------------------------------------------
async function initDashboard() {
  await loadStatus();
  loadDocuments();
  loadLogs();
}

async function loadStatus() {
  try {
    const response = await fetch('/api/admin/status', {
      headers: { 'x-admin-password': adminPassword }
    });
    
    if (!response.ok) return;
    const data = await response.json();

    // Render configuration info
    document.getElementById('drive-folder-badge').textContent = data.folderId;
    document.getElementById('metric-docs').textContent = data.filesCount;
    document.getElementById('metric-queries').textContent = data.logsCount;

    // Render Sync Info
    const statusVal = document.getElementById('metric-status');
    const syncTimeText = document.getElementById('metric-sync-time');
    
    if (data.sync.isSyncing) {
      statusVal.textContent = 'Sincronizando...';
      statusVal.className = 'metric-val text-indigo';
      setSyncLoadingState(true);
      startPollingSyncStatus();
    } else {
      statusVal.textContent = 'Listo';
      statusVal.className = 'metric-val text-green';
      setSyncLoadingState(false);
      
      if (data.sync.lastSyncTime) {
        const date = new Date(data.sync.lastSyncTime);
        syncTimeText.textContent = `Último: ${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      } else {
        syncTimeText.textContent = 'Último: Nunca';
      }
    }
  } catch (error) {
    console.error('Error fetching status:', error);
  }
}

async function loadDocuments() {
  try {
    const response = await fetch('/api/admin/files', {
      headers: { 'x-admin-password': adminPassword }
    });

    if (!response.ok) return;
    allFiles = await response.json();

    renderDocumentsTable(allFiles);
    renderRecentDocuments(allFiles);
  } catch (error) {
    console.error('Error loading documents:', error);
  }
}

function renderDocumentsTable(files) {
  const tbody = document.getElementById('docs-tbody');
  tbody.innerHTML = '';

  if (files.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted py-4">No se encontraron documentos</td></tr>`;
    return;
  }

  files.forEach(file => {
    const tr = document.createElement('tr');
    
    // File Size Formatting
    const sizeKB = (file.size / 1024).toFixed(1);
    const sizeStr = sizeKB > 1024 ? `${(sizeKB / 1024).toFixed(1)} MB` : `${sizeKB} KB`;

    // Date formatting
    const driveDate = new Date(file.modified_time).toLocaleString();
    const syncDate = new Date(file.synced_at).toLocaleString();

    tr.innerHTML = `
      <td><strong>${escapeHTML(file.name)}</strong></td>
      <td><span class="badge">${escapeHTML(file.mime_type)}</span></td>
      <td>${sizeStr}</td>
      <td>${driveDate}</td>
      <td>${syncDate}</td>
      <td class="text-right">
        <a href="#" class="action-link btn-view-summary" data-id="${file.id}">Ver Resumen</a>
      </td>
    `;
    tbody.appendChild(tr);
  });

  // Attach click events to modal buttons
  document.querySelectorAll('.btn-view-summary').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const fileId = btn.getAttribute('data-id');
      const file = files.find(f => f.id === fileId);
      if (file) openSummaryModal(file);
    });
  });
}

function renderRecentDocuments(files) {
  const tbody = document.getElementById('recent-docs-tbody');
  tbody.innerHTML = '';

  if (files.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3" class="text-center text-muted">No hay documentos sincronizados</td></tr>`;
    return;
  }

  // Sort by sync date descending and take top 5
  const sorted = [...files].sort((a, b) => new Date(b.synced_at) - new Date(a.synced_at)).slice(0, 5);

  sorted.forEach(file => {
    const tr = document.createElement('tr');
    const sizeKB = (file.size / 1024).toFixed(1);
    const sizeStr = sizeKB > 1024 ? `${(sizeKB / 1024).toFixed(1)} MB` : `${sizeKB} KB`;
    
    tr.innerHTML = `
      <td><strong>${escapeHTML(file.name)}</strong></td>
      <td><span class="badge">${escapeHTML(file.mime_type.split('/')[1] || file.mime_type)}</span></td>
      <td>${sizeStr}</td>
    `;
    tbody.appendChild(tr);
  });
}

function filterDocuments(query) {
  const filtered = allFiles.filter(f => f.name.toLowerCase().includes(query.toLowerCase()));
  renderDocumentsTable(filtered);
}

function openSummaryModal(file) {
  document.getElementById('modal-filename').textContent = file.name;
  
  // Format summary markdown simply for representation (replace title markdown headers and bullet points)
  const renderedSummary = formatSummaryText(file.summary);
  document.getElementById('modal-summary-content').innerHTML = renderedSummary;
  
  document.getElementById('summary-modal').classList.add('active');
}

function formatSummaryText(text) {
  // Simple markdown conversion for display inside modal
  let html = escapeHTML(text);
  
  // Bold
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
  
  // Newlines
  html = html.replace(/\n/g, '<br>');
  
  return html;
}

async function loadLogs() {
  try {
    const response = await fetch('/api/admin/logs', {
      headers: { 'x-admin-password': adminPassword }
    });

    if (!response.ok) return;
    const logs = await response.json();

    renderLogsTable(logs);
  } catch (error) {
    console.error('Error loading logs:', error);
  }
}

function renderLogsTable(logs) {
  const tbody = document.getElementById('logs-tbody');
  tbody.innerHTML = '';

  if (logs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted py-4">No hay consultas registradas aún</td></tr>`;
    return;
  }

  logs.forEach(log => {
    const tr = document.createElement('tr');
    const logDate = new Date(log.timestamp).toLocaleString();
    
    // Platform Badge class
    const platClass = log.platform === 'google-chat' ? 'bg-indigo' : 'bg-purple';
    const platName = log.platform === 'google-chat' ? 'Google Chat' : 'Playground';
    
    // Format sources list
    const sourcesList = log.sources && log.sources.length > 0 
      ? log.sources.map(s => `<span class="badge" style="margin:2px 0;">${escapeHTML(s)}</span>`).join(' ')
      : '<span class="text-muted">Ninguna</span>';

    tr.innerHTML = `
      <td><span style="font-size:0.8rem; white-space:nowrap;">${logDate}</span></td>
      <td><span class="badge ${platClass}">${platName}</span></td>
      <td><strong>${escapeHTML(log.user_name || 'Desconocido')}</strong></td>
      <td style="max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHTML(log.question)}</td>
      <td style="max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHTML(log.answer)}</td>
      <td>${sourcesList}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ----------------------------------------------------
// Google Drive Manual Syncing
// ----------------------------------------------------
async function triggerSync() {
  const btn = document.getElementById('btn-sync-now');
  if (btn.disabled) return;

  try {
    const response = await fetch('/api/admin/sync', {
      method: 'POST',
      headers: { 'x-admin-password': adminPassword }
    });

    if (response.ok) {
      setSyncLoadingState(true);
      document.getElementById('metric-status').textContent = 'Sincronizando...';
      document.getElementById('metric-status').className = 'metric-val text-indigo';
      startPollingSyncStatus();
    } else {
      const err = await response.json();
      alert(`Error al iniciar sincronización: ${err.error}`);
    }
  } catch (error) {
    console.error('Error triggering sync:', error);
    alert('Error de conexión al iniciar sincronización.');
  }
}

function setSyncLoadingState(isLoading) {
  const btn = document.getElementById('btn-sync-now');
  const icon = document.getElementById('sync-icon');
  const txt = document.getElementById('sync-text');

  if (isLoading) {
    btn.disabled = true;
    icon.classList.add('spinning');
    txt.textContent = 'Sincronizando...';
  } else {
    btn.disabled = false;
    icon.classList.remove('spinning');
    txt.textContent = 'Sincronizar Drive';
  }
}

function startPollingSyncStatus() {
  if (isSyncStatusPolling) return;
  isSyncStatusPolling = true;

  const pollInterval = setInterval(async () => {
    try {
      const response = await fetch('/api/admin/status', {
        headers: { 'x-admin-password': adminPassword }
      });
      if (!response.ok) return;
      const data = await response.json();

      if (!data.sync.isSyncing) {
        // Sync finished! Stop polling
        clearInterval(pollInterval);
        isSyncStatusPolling = false;
        
        // Refresh everything
        initDashboard();
        
        if (data.sync.lastSyncResult && data.sync.lastSyncResult.success) {
          const res = data.sync.lastSyncResult;
          alert(`Sincronización Completada:\n- Agregados: ${res.addedCount}\n- Actualizados: ${res.updatedCount}\n- Eliminados: ${res.deletedCount}`);
        } else if (data.sync.lastSyncResult) {
          alert(`Sincronización Fallida: ${data.sync.lastSyncResult.error}`);
        }
      }
    } catch (e) {
      console.error('Polling error:', e);
      clearInterval(pollInterval);
      isSyncStatusPolling = false;
    }
  }, 3000);
}

// ----------------------------------------------------
// Chat Playgrounds (Overview & Full Tab)
// ----------------------------------------------------
async function sendMiniChat() {
  const inputEl = document.getElementById('mini-chat-input');
  const query = inputEl.value.trim();
  if (!query) return;

  inputEl.value = '';
  appendMessage('mini-chat-messages', 'user', query);
  
  // Typing Indicator
  const typingId = appendTypingIndicator('mini-chat-messages');

  try {
    const response = await fetch('/api/admin/playground', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-password': adminPassword
      },
      body: JSON.stringify({ question: query })
    });

    removeTypingIndicator('mini-chat-messages', typingId);

    if (response.ok) {
      const data = await response.json();
      appendMessage('mini-chat-messages', 'bot', data.answer);
    } else {
      appendMessage('mini-chat-messages', 'bot', '❌ Error al procesar tu consulta.');
    }
  } catch (error) {
    removeTypingIndicator('mini-chat-messages', typingId);
    appendMessage('mini-chat-messages', 'bot', '❌ Error de red al consultar.');
  }
}

async function sendFullChat() {
  const inputEl = document.getElementById('play-chat-input');
  const query = inputEl.value.trim();
  if (!query) return;

  inputEl.value = '';
  appendMessage('play-chat-messages', 'user', query);
  
  // Typing Indicator
  const typingId = appendTypingIndicator('play-chat-messages');

  try {
    const response = await fetch('/api/admin/playground', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-password': adminPassword
      },
      body: JSON.stringify({ question: query })
    });

    removeTypingIndicator('play-chat-messages', typingId);

    if (response.ok) {
      const data = await response.json();
      appendMessage('play-chat-messages', 'bot', data.answer);
      renderPlaygroundSources(data.sources);
    } else {
      appendMessage('play-chat-messages', 'bot', '❌ Error al procesar tu consulta.');
      renderPlaygroundSources([]);
    }
  } catch (error) {
    removeTypingIndicator('play-chat-messages', typingId);
    appendMessage('play-chat-messages', 'bot', '❌ Error de red al consultar.');
    renderPlaygroundSources([]);
  }
}

function appendMessage(containerId, role, text) {
  const container = document.getElementById(containerId);
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${role}`;
  bubble.innerHTML = `<div class="bubble-content">${formatSummaryText(text)}</div>`;
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
}

function appendTypingIndicator(containerId) {
  const container = document.getElementById(containerId);
  const bubble = document.createElement('div');
  const id = 'typing_' + Date.now();
  bubble.className = 'chat-bubble bot temp-typing';
  bubble.id = id;
  bubble.innerHTML = `
    <div class="bubble-content">
      <div class="typing-indicator">
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
      </div>
    </div>
  `;
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
  return id;
}

function removeTypingIndicator(containerId, typingId) {
  const bubble = document.getElementById(typingId);
  if (bubble) bubble.remove();
}

function renderPlaygroundSources(sources) {
  const container = document.getElementById('playground-sources');
  container.innerHTML = '';

  if (!sources || sources.length === 0) {
    container.innerHTML = `<div class="text-muted text-center py-4">No se utilizaron fuentes para responder la última pregunta o no hubo resultados relevantes.</div>`;
    return;
  }

  sources.forEach(src => {
    const item = document.createElement('div');
    item.className = 'source-item';
    
    const percentage = Math.round(src.score * 100);
    const boundedPct = Math.max(0, Math.min(100, percentage)); // Ensure 0-100 range

    item.innerHTML = `
      <div class="source-title-wrapper">
        <span class="source-name" title="${escapeHTML(src.name)}">${escapeHTML(src.name)}</span>
        <span class="source-score">${percentage}%</span>
      </div>
      <div class="progress-bar-bg">
        <div class="progress-bar-fill" style="width: ${boundedPct}%"></div>
      </div>
    `;
    container.appendChild(item);
  });
}

// ----------------------------------------------------
// Utilities
// ----------------------------------------------------
function escapeHTML(str) {
  return str.replace(/[&<>'"]/g, 
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag)
  );
}
