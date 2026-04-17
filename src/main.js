// src/main.js

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');

log.transports.file.level    = 'info';
log.transports.console.level = 'debug';
autoUpdater.logger           = log;
autoUpdater.autoDownload     = true;
autoUpdater.autoInstallOnAppQuit = true;

const isDev = process.argv.includes('--dev') || !app.isPackaged;

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960, height: 700, minWidth: 820, minHeight: 580,
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

// BUG-C CORRIGIDO: save-config agora retorna erros de validacao ao renderer
ipcMain.handle('save-config', (_event, partial) => {
  const { saveConfig } = require('./config');
  return saveConfig(partial); // retorna { ok, errors? } ou { ok, config }
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
  if (isDev) {
    log.info('Modo dev — auto-updater desabilitado.');
    return;
  }

  // CAUSA 4 CORRIGIDA: autoDownload false — controlamos o download manualmente
  // para poder mostrar erro e ter retry em caso de falha
  autoUpdater.autoDownload            = false;
  autoUpdater.autoInstallOnAppQuit    = true;
  autoUpdater.allowDowngrade          = false;

  // CAUSA 1 CORRIGIDA: se o repositório for privado, defina GH_TOKEN como
  // variável de ambiente no build ou use repositório público.
  // Para repositório PÚBLICO não é necessário token.
  // Se precisar de repositório privado, descomente e configure:
  // process.env.GH_TOKEN = 'seu_token_readonly_aqui';

  let downloadTimeout = null;

  autoUpdater.on('checking-for-update', () => {
    log.info('Verificando atualizacoes...');
    sendToRenderer('update-status', { type: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    log.info(`Atualizacao disponivel: v${info.version}`);
    sendToRenderer('update-status', { type: 'available', version: info.version });

    // Inicia o download após confirmar que há atualização
    autoUpdater.downloadUpdate().catch(err => {
      log.error('Erro ao iniciar download:', err.message);
      sendToRenderer('update-status', { type: 'error', message: err.message });
    });

    // CAUSA 3 CORRIGIDA: timeout de 5 minutos no download
    // Se não terminar em 5 min, loga o erro e tenta de novo na próxima verificação
    downloadTimeout = setTimeout(() => {
      log.warn('Timeout no download da atualizacao — sera tentado novamente.');
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
      bytesPerSecond: Math.round(p.bytesPerSecond / 1024), // KB/s
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    if (downloadTimeout) clearTimeout(downloadTimeout);
    log.info(`Atualizacao v${info.version} baixada com sucesso.`);
    sendToRenderer('update-status', { type: 'downloaded', version: info.version });
    // Instala ao fechar — mais seguro que forçar reinício imediato
    // O quitAndInstall(false, true) reinicia sem perguntar
    setTimeout(() => autoUpdater.quitAndInstall(false, true), 3000);
  });

  // CAUSA 2 CORRIGIDA: erros do updater logados E enviados para a interface
  autoUpdater.on('error', (err) => {
    if (downloadTimeout) clearTimeout(downloadTimeout);
    log.error('Erro no auto-updater:', err.message);
    sendToRenderer('update-status', { type: 'error', message: err.message });
  });

  // Primeira verificação após 15s (dá tempo do app carregar completamente)
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(err => {
      log.warn('Falha ao verificar atualizacoes:', err.message);
    });
  }, 15_000);

  // Recheck a cada 4 horas
  setInterval(() => {
    autoUpdater.checkForUpdates().catch(err => {
      log.warn('Falha ao verificar atualizacoes:', err.message);
    });
  }, 4 * 60 * 60 * 1000);
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