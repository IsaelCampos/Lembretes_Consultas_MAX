// src/main.js

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');

log.transports.file.level = 'info';
log.transports.console.level = 'debug';
autoUpdater.logger = log;
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

const isDev = process.argv.includes('--dev') || !app.isPackaged;

let mainWindow = null;
let cleanupStarted = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 700,
    minWidth: 820,
    minHeight: 580,
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
    try {
      const parsed = new URL(url);
      const allowedProtocols = new Set(['http:', 'https:', 'mailto:']);
      if (!allowedProtocols.has(parsed.protocol)) {
        log.warn(`Bloqueando abertura de URL externa com protocolo nao permitido: ${url}`);
        return { action: 'deny' };
      }
      shell.openExternal(url);
    } catch {
      log.warn(`Bloqueando abertura de URL externa invalida: ${url}`);
    }
    return { action: 'deny' };
  });
}

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

async function cleanupForExit(reason) {
  if (cleanupStarted) return;
  cleanupStarted = true;

  log.info(`Encerrando servicos para saida do app (${reason})...`);

  try {
    const { stopScheduler } = require('./scheduler');
    stopScheduler();
  } catch (err) {
    log.warn(`Falha ao encerrar scheduler: ${err.message}`);
  }

  try {
    const { shutdownWhatsApp } = require('./whatsapp');
    await shutdownWhatsApp();
  } catch (err) {
    log.warn(`Falha ao encerrar WhatsApp: ${err.message}`);
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

function setupAutoUpdater() {
  if (isDev) {
    log.info('Modo dev - auto-updater desabilitado.');
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;

  let downloadTimeout = null;

  autoUpdater.on('checking-for-update', () => {
    log.info('Verificando atualizacoes...');
    sendToRenderer('update-status', { type: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    log.info(`Atualizacao disponivel: v${info.version}`);
    sendToRenderer('update-status', { type: 'available', version: info.version });

    autoUpdater.downloadUpdate().catch((err) => {
      log.error('Erro ao iniciar download:', err.message);
      sendToRenderer('update-status', { type: 'error', message: err.message });
    });

    downloadTimeout = setTimeout(() => {
      log.warn('Timeout no download da atualizacao - sera tentado novamente.');
      sendToRenderer('update-status', { type: 'download-timeout' });
    }, 5 * 60 * 1000);
  });

  autoUpdater.on('update-not-available', () => {
    log.info('Nenhuma atualizacao disponivel.');
    sendToRenderer('update-status', { type: 'up-to-date' });
  });

  autoUpdater.on('download-progress', (p) => {
    sendToRenderer('update-status', {
      type: 'downloading',
      percent: Math.round(p.percent),
      bytesPerSecond: Math.round(p.bytesPerSecond / 1024),
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    if (downloadTimeout) clearTimeout(downloadTimeout);
    log.info(`Atualizacao v${info.version} baixada com sucesso.`);
    sendToRenderer('update-status', { type: 'downloaded', version: info.version });

    setTimeout(async () => {
      await cleanupForExit('auto-update');
      log.info('Chamando quitAndInstall...');
      autoUpdater.quitAndInstall(false, true);
    }, 3000);
  });

  autoUpdater.on('error', (err) => {
    if (downloadTimeout) clearTimeout(downloadTimeout);
    log.error('Erro no auto-updater:', err.message);
    sendToRenderer('update-status', { type: 'error', message: err.message });
  });

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      log.warn('Falha ao verificar atualizacoes:', err.message);
    });
  }, 15_000);

  setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      log.warn('Falha ao verificar atualizacoes:', err.message);
    });
  }, 4 * 60 * 60 * 1000);
}

app.whenReady().then(() => {
  createWindow();
  setupAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit-for-update', () => {
  log.info('Evento before-quit-for-update recebido.');
});

app.on('before-quit', () => {
  log.info('Evento before-quit recebido.');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
