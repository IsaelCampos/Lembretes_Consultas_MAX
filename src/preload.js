// src/preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // WhatsApp
  startWhatsApp:      ()        => ipcRenderer.invoke('start-whatsapp'),
  openLogs:           ()        => ipcRenderer.invoke('open-logs'),

  // Agendador
  runNow:             (tabName) => ipcRenderer.invoke('run-now', tabName),
  startScheduler:     ()        => ipcRenderer.invoke('start-scheduler'),
  stopScheduler:      ()        => ipcRenderer.invoke('stop-scheduler'),
  getSchedulerStatus: ()        => ipcRenderer.invoke('get-scheduler-status'),

  // Configuracoes
  getConfig:          ()        => ipcRenderer.invoke('get-config'),
  saveConfig:         (cfg)     => ipcRenderer.invoke('save-config', cfg),
  pickCredentials:    ()        => ipcRenderer.invoke('pick-credentials'),

  // Eventos
  onQrCode:           (fn) => ipcRenderer.on('qr-code',       (_e, d) => fn(d)),
  onWaStatus:         (fn) => ipcRenderer.on('wa-status',     (_e, d) => fn(d)),
  onLog:              (fn) => ipcRenderer.on('log-message',   (_e, d) => fn(d)),
  onMsgSent:          (fn) => ipcRenderer.on('msg-sent',      (_e, d) => fn(d)),
  onUpdateStatus:     (fn) => ipcRenderer.on('update-status', (_e, d) => fn(d)),
  // MELHORIA-7: evento de ultima verificacao
  onLastCheck:        (fn) => ipcRenderer.on('last-check',    (_e, d) => fn(d)),
});