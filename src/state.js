// src/state.js
// Persiste em disco quais mensagens ja foram enviadas

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
  const cutoff7d = Date.now() - 7  * 24 * 60 * 60 * 1000;
  const cutoff1y = Date.now() - 366 * 24 * 60 * 60 * 1000;

  for (const key of Object.keys(state.hourBefore || {})) {
    if ((state.hourBefore[key].sentAt || 0) < cutoff7d)
      delete state.hourBefore[key];
  }
  for (const key of Object.keys(state.birthdays || {})) {
    if ((state.birthdays[key].sentAt || 0) < cutoff1y)
      delete state.birthdays[key];
  }
  // BUG 4 CORRIGIDO: siteConfirmed agora expira apos 90 dias.
  // Chave composta rowIndex__telefone evita bloquear nova linha
  // que reutilize o mesmo rowIndex apos delecao de registro antigo.
  const cutoff90d = Date.now() - 90 * 24 * 60 * 60 * 1000;
  for (const key of Object.keys(state.siteConfirmed || {})) {
    if ((state.siteConfirmed[key].sentAt || 0) < cutoff90d)
      delete state.siteConfirmed[key];
  }

  return state;
}

// ─── Lembrete 1h antes ───────────────────────────────────────────────────────
// Chave: rowIndex + data — sobrevive a reinicializacoes

function wasHourBeforeSent(rowIndex, data) {
  const state = loadState();
  return !!(state.hourBefore && state.hourBefore[`${rowIndex}__${data}`]);
}

function markHourBeforeSent(rowIndex, data, nome) {
  const state = pruneOldEntries(loadState());
  if (!state.hourBefore) state.hourBefore = {};
  state.hourBefore[`${rowIndex}__${data}`] = { nome, sentAt: Date.now() };
  saveState(state);
}

// ─── Aniversario ─────────────────────────────────────────────────────────────
// Chave: telefone + ano — reenvia a cada aniversario

function wasBirthdaySentThisYear(telefone) {
  const state = loadState();
  const key   = `${normalizePhone(telefone)}__${new Date().getFullYear()}`;
  return !!(state.birthdays && state.birthdays[key]);
}

function markBirthdaySent(telefone, nome) {
  const state = pruneOldEntries(loadState());
  if (!state.birthdays) state.birthdays = {};
  const key = `${normalizePhone(telefone)}__${new Date().getFullYear()}`;
  state.birthdays[key] = { nome, sentAt: Date.now() };
  saveState(state);
}

function normalizePhone(raw) {
  return String(raw || '').replace(/\D/g, '');
}

// ─── Confirmacao do site ──────────────────────────────────────────────────────
// BUG 4 CORRIGIDO: chave agora e rowIndex + telefone.
// Se uma linha for deletada e outra ocupar o mesmo rowIndex,
// o telefone diferente garante que a nova linha sera notificada.

function wasSiteConfirmationSent(rowIndex, telefone) {
  const state = loadState();
  const key   = `${rowIndex}__${normalizePhone(telefone)}`;
  return !!(state.siteConfirmed && state.siteConfirmed[key]);
}

function markSiteConfirmationSent(rowIndex, telefone, nome) {
  const state = pruneOldEntries(loadState());
  if (!state.siteConfirmed) state.siteConfirmed = {};
  const key = `${rowIndex}__${normalizePhone(telefone)}`;
  state.siteConfirmed[key] = { nome, sentAt: Date.now() };
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