// src/main.js
// Processo principal do Electron

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');

// Configura logs — salvos em AppData/Roaming/whatsapp-lembrete/logs/
log.transports.file.level = 'info';
log.transports.console.level = 'debug';
autoUpdater.logger = log;
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

let mainWindow = null;

// ─── Janela principal ────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 780,
    minHeight: 560,
    title: 'WhatsApp Lembrete',
    icon: path.join(__dirname, '../assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: '#0f172a',
    show: false, // evita flash branco
  });

  mainWindow.loadFile(path.join(__dirname, 'ui/index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Abre links externos no browser padrão
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ─── IPC — comunicação Renderer ↔ Main ──────────────────────────────────────

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// Expõe sendToRenderer globalmente para o whatsapp.js e scheduler.js usarem
global.sendToRenderer = sendToRenderer;

// Handler: renderer pede para iniciar o WhatsApp
ipcMain.handle('start-whatsapp', async () => {
  const { initWhatsApp } = require('./whatsapp');
  await initWhatsApp();
});

// Handler: renderer pede para rodar verificação agora
// tabName pode ser "Agendamentos" ou "Teste"
ipcMain.handle('run-now', async (_event, tabName) => {
  const { runOnce } = require('./scheduler');
  await runOnce(tabName);
});

// Handler: liga modo produção
ipcMain.handle('start-scheduler', () => {
  const { startScheduler } = require('./scheduler');
  return startScheduler();
});

// Handler: desliga modo produção
ipcMain.handle('stop-scheduler', () => {
  const { stopScheduler } = require('./scheduler');
  return stopScheduler();
});

// Handler: retorna se o agendador está rodando
ipcMain.handle('get-scheduler-status', () => {
  const { getIsRunning } = require('./scheduler');
  return getIsRunning();
});

// Handler: abre pasta de logs
ipcMain.handle('open-logs', () => {
  shell.openPath(log.transports.file.getFile().path.replace(/[^/\\]+$/, ''));
});

// Handler: retorna config atual
ipcMain.handle('get-config', () => {
  const { loadConfig } = require('./config');
  return loadConfig();
});

// Handler: salva config
ipcMain.handle('save-config', (_event, partial) => {
  const { saveConfig } = require('./config');
  return saveConfig(partial);
});

// Handler: abre diálogo para selecionar o credentials.json
ipcMain.handle('pick-credentials', async () => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog(mainWindow, {
    title:       'Selecione o arquivo credentials.json',
    buttonLabel: 'Selecionar',
    filters:     [{ name: 'JSON', extensions: ['json'] }],
    properties:  ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// ─── Auto-updater ────────────────────────────────────────────────────────────

function setupAutoUpdater() {
  autoUpdater.on('checking-for-update', () => {
    log.info('Verificando atualizações...');
    sendToRenderer('update-status', { type: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    log.info('Atualização disponível:', info.version);
    sendToRenderer('update-status', { type: 'available', version: info.version });
  });

  autoUpdater.on('update-not-available', () => {
    log.info('Nenhuma atualização disponível.');
    sendToRenderer('update-status', { type: 'up-to-date' });
  });

  autoUpdater.on('download-progress', (progress) => {
    sendToRenderer('update-status', {
      type: 'downloading',
      percent: Math.round(progress.percent),
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    log.info('Atualização baixada:', info.version);
    sendToRenderer('update-status', { type: 'downloaded', version: info.version });
    // Instala e reinicia automaticamente após 5 segundos
    setTimeout(() => autoUpdater.quitAndInstall(), 5000);
  });

  autoUpdater.on('error', (err) => {
    log.error('Erro no auto-updater:', err.message);
    // Não quebra o app se não houver servidor de update configurado
  });

  // Verifica a cada 4 horas
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 3000);
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();
  setupAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});