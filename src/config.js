// src/config.js
// Gerencia as configurações do app — salvas em config.json no userData
// O cliente configura tudo pela interface, sem editar arquivos manualmente

const fs   = require('fs');
const path = require('path');
const { app } = require('electron');

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

const DEFAULTS = {
  googleSheetId:        '',
  credentialsPath:      '',
  timezone:             'America/Fortaleza',
  birthdayTab:          'Aniversário',
  appointmentsTab:      'Agendamentos_Manual',
  siteAppointmentsTab:  'Agendamentos_Site',
  siteConfirmedStatus:  'confirmado',
  testTab:              'Teste',
  rescheduleTab:        'Remarcar',
  birthdayTime:         '09:00',
  contactInfo:          '',
};

/**
 * Lê as configurações salvas, preenchendo defaults para campos ausentes
 */
function loadConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * Salva as configurações em disco
 */
function saveConfig(partial) {
  const current = loadConfig();
  const updated = { ...current, ...partial };
  fs.writeFileSync(configPath(), JSON.stringify(updated, null, 2), 'utf8');
  return updated;
}

/**
 * Retorna true se as configurações mínimas necessárias estão preenchidas
 */
function isConfigured() {
  const cfg = loadConfig();
  return !!(cfg.googleSheetId && cfg.credentialsPath && fs.existsSync(cfg.credentialsPath));
}

module.exports = { loadConfig, saveConfig, isConfigured, configPath };