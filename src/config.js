// src/config.js
// Gerencia configuracoes do app — salvas em config.json no userData

const fs   = require('fs');
const path = require('path');
const { app } = require('electron');

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

const DEFAULTS = {
  googleSheetId:          '',
  credentialsPath:        '',
  timezone:               'America/Fortaleza',
  birthdayTab:            'Aniversário',
  appointmentsTab:        'Agendamentos_Manual',
  siteAppointmentsTab:    'Agendamentos_Site',
  siteConfirmedStatus:    'confirmado',
  testTab:                'Teste',
  rescheduleTab:          'Remarcar',
  birthdayTime:           '09:00',
  contactInfo:            '',
  // MELHORIA-1: janela de lembrete configuravel
  reminderMinutes:        60,   // quantos minutos antes da consulta enviar
  reminderWindowMinutes:  10,   // margem de tolerancia (±) em minutos
};

function loadConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    // Garante que numeros salvos como string viram number
    if (parsed.reminderMinutes)       parsed.reminderMinutes       = Number(parsed.reminderMinutes);
    if (parsed.reminderWindowMinutes) parsed.reminderWindowMinutes = Number(parsed.reminderWindowMinutes);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

// BUG-C CORRIGIDO: validacao antes de salvar — rejeita dados malformados
function validateConfig(partial) {
  const errors = [];

  if (partial.birthdayTime !== undefined) {
    if (!/^\d{1,2}:\d{2}$/.test(String(partial.birthdayTime))) {
      errors.push('Horario de aniversario invalido. Use o formato HH:MM (ex: 09:00).');
    } else {
      const [h, m] = String(partial.birthdayTime).split(':').map(Number);
      if (h > 23 || m > 59) errors.push('Horario de aniversario fora do intervalo valido (00:00 a 23:59).');
    }
  }

  if (partial.reminderMinutes !== undefined) {
    const v = Number(partial.reminderMinutes);
    if (isNaN(v) || v < 5 || v > 480)
      errors.push('Antecedencia do lembrete deve ser entre 5 e 480 minutos.');
  }

  if (partial.reminderWindowMinutes !== undefined) {
    const v = Number(partial.reminderWindowMinutes);
    if (isNaN(v) || v < 1 || v > 60)
      errors.push('Margem de tolerancia deve ser entre 1 e 60 minutos.');
  }

  if (partial.googleSheetId !== undefined) {
    const id = String(partial.googleSheetId).trim();
    if (id && !/^[a-zA-Z0-9_-]{20,}$/.test(id))
      errors.push('ID da planilha parece invalido. Verifique a URL do Google Sheets.');
  }

  if (partial.credentialsPath !== undefined && partial.credentialsPath) {
    if (!fs.existsSync(partial.credentialsPath))
      errors.push('Arquivo credentials.json nao encontrado no caminho informado.');
  }

  return errors;
}

function saveConfig(partial) {
  // BUG-C CORRIGIDO: valida antes de salvar
  const errors = validateConfig(partial);
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const current = loadConfig();
  const updated = { ...current, ...partial };
  // Normaliza numericos
  updated.reminderMinutes       = Number(updated.reminderMinutes)       || 60;
  updated.reminderWindowMinutes = Number(updated.reminderWindowMinutes) || 10;

  fs.writeFileSync(configPath(), JSON.stringify(updated, null, 2), 'utf8');
  return { ok: true, config: updated };
}

function isConfigured() {
  const cfg = loadConfig();
  return !!(cfg.googleSheetId && cfg.credentialsPath && fs.existsSync(cfg.credentialsPath));
}

module.exports = { loadConfig, saveConfig, validateConfig, isConfigured, configPath };