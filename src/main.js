// src/main.js
// Processo principal do Electron

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');

log.transports.file.level    = 'info';
log.transports.console.level = 'debug';
autoUpdater.logger           = log;
autoUpdater.autoDownload     = true;
autoUpdater.autoInstallOnAppQuit = true;

// BUG 7 CORRIGIDO: detecta modo dev para nao disparar updater desnecessariamente
const isDev = process.argv.includes('--dev') || !app.isPackaged;

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900, height: 680, minWidth: 780, minHeight: 560,
    title: 'WhatsApp Lembrete',
    icon: path.join(__dirname, '../assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: '#0f172a',
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'ui/index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ─── IPC ─────────────────────────────────────────────────────────────────────

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

global.sendToRenderer = sendToRenderer;

ipcMain.handle('start-whatsapp', async () => {
  const { initWhatsApp } = require('./whatsapp');
  await initWhatsApp();
});

ipcMain.handle('run-now', async (_event, tabName) => {
  const { runOnce } = require('./scheduler');
  await runOnce(tabName);
});

ipcMain.handle('start-scheduler', () => {
  const { startScheduler } = require('./scheduler');
  return startScheduler();
});

ipcMain.handle('stop-scheduler', () => {
  const { stopScheduler } = require('./scheduler');
  return stopScheduler();
});

ipcMain.handle('get-scheduler-status', () => {
  const { getIsRunning } = require('./scheduler');
  return getIsRunning();
});

ipcMain.handle('open-logs', () => {
  shell.openPath(log.transports.file.getFile().path.replace(/[^/\\]+$/, ''));
});

ipcMain.handle('get-config', () => {
  const { loadConfig } = require('./config');
  return loadConfig();
});

ipcMain.handle('save-config', (_event, partial) => {
  const { saveConfig } = require('./config');
  return saveConfig(partial);
});

ipcMain.handle('pick-credentials', async () => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Selecione o arquivo credentials.json',
    buttonLabel: 'Selecionar',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// ─── Auto-updater ─────────────────────────────────────────────────────────────

function setupAutoUpdater() {
  // BUG 7 CORRIGIDO: em modo dev nao verifica atualizacoes
  if (isDev) {
    log.info('Modo dev — auto-updater desabilitado.');
    return;
  }

  autoUpdater.on('checking-for-update', () => {
    log.info('Verificando atualizacoes...');
    sendToRenderer('update-status', { type: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    log.info('Atualizacao disponivel:', info.version);
    sendToRenderer('update-status', { type: 'available', version: info.version });
  });

  autoUpdater.on('update-not-available', () => {
    log.info('Nenhuma atualizacao disponivel.');
    sendToRenderer('update-status', { type: 'up-to-date' });
  });

  autoUpdater.on('download-progress', (progress) => {
    sendToRenderer('update-status', {
      type: 'downloading', percent: Math.round(progress.percent),
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    log.info('Atualizacao baixada:', info.version);
    sendToRenderer('update-status', { type: 'downloaded', version: info.version });
    setTimeout(() => autoUpdater.quitAndInstall(), 5000);
  });

  autoUpdater.on('error', (err) => {
    log.error('Erro no auto-updater:', err.message);
  });

  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 10_000);
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

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