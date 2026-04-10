// src/state.js
// Persiste em disco quais mensagens já foram enviadas
// Garante que após reiniciar o app não reenvia mensagens antigas

const fs   = require('fs');
const path = require('path');
const { app } = require('electron');

function statePath() {
  return path.join(app.getPath('userData'), 'sent-state.json');
}

function loadState() {
  try {
    const raw = fs.readFileSync(statePath(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return { birthdays: {}, hourBefore: {}, siteConfirmed: {} };
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(statePath(), JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.error('Erro ao salvar estado:', err.message);
  }
}

function pruneOldEntries(state) {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const section of ['birthdays', 'hourBefore', 'siteConfirmed']) {
    for (const key of Object.keys(state[section] || {})) {
      if ((state[section][key].sentAt || 0) < cutoff) {
        delete state[section][key];
      }
    }
  }
  return state;
}

// ─── Lembrete 1h antes ───────────────────────────────────────────────────────

function wasHourBeforeSent(rowIndex, data) {
  const state = loadState();
  const key   = `${rowIndex}__${data}`;
  return !!(state.hourBefore && state.hourBefore[key]);
}

function markHourBeforeSent(rowIndex, data, nome) {
  const state = pruneOldEntries(loadState());
  if (!state.hourBefore) state.hourBefore = {};
  state.hourBefore[`${rowIndex}__${data}`] = { nome, sentAt: Date.now() };
  saveState(state);
}

// ─── Aniversário ─────────────────────────────────────────────────────────────

function wasBirthdaySentThisYear(telefone) {
  const state = loadState();
  const key   = `${telefone}__${new Date().getFullYear()}`;
  return !!(state.birthdays && state.birthdays[key]);
}

function markBirthdaySent(telefone, nome) {
  const state = pruneOldEntries(loadState());
  if (!state.birthdays) state.birthdays = {};
  state.birthdays[`${telefone}__${new Date().getFullYear()}`] = { nome, sentAt: Date.now() };
  saveState(state);
}

// ─── Confirmação do site (status → "confirmado") ──────────────────────────────
// Chave: rowIndex — assim só envia uma vez por agendamento, mesmo após reinício

function wasSiteConfirmationSent(rowIndex) {
  const state = loadState();
  return !!(state.siteConfirmed && state.siteConfirmed[String(rowIndex)]);
}

function markSiteConfirmationSent(rowIndex, nome) {
  const state = pruneOldEntries(loadState());
  if (!state.siteConfirmed) state.siteConfirmed = {};
  state.siteConfirmed[String(rowIndex)] = { nome, sentAt: Date.now() };
  saveState(state);
}

module.exports = {
  wasHourBeforeSent,
  markHourBeforeSent,
  wasBirthdaySentThisYear,
  markBirthdaySent,
  wasSiteConfirmationSent,
  markSiteConfirmationSent,
};