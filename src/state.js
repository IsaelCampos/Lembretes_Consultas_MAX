// src/state.js
// Persiste em disco quais mensagens ja foram enviadas

const fs   = require('fs');
const path = require('path');
const { app } = require('electron');

function statePath() {
  return path.join(app.getPath('userData'), 'sent-state.json');
}

// BUG-F CORRIGIDO: fila de escrita para evitar race condition entre jobs paralelos
let writeQueue = Promise.resolve();

function enqueueWrite(fn) {
  writeQueue = writeQueue.then(fn).catch(err => {
    console.error('Erro na fila de escrita do state:', err.message);
  });
  return writeQueue;
}

function loadState() {
  try {
    const raw = fs.readFileSync(statePath(), 'utf8');
    const parsed = JSON.parse(raw);
    // Garante que todas as secoes existem mesmo em arquivos antigos
    return {
      birthdays:    parsed.birthdays    || {},
      hourBefore:   parsed.hourBefore   || {},
      siteConfirmed: parsed.siteConfirmed || {},
    };
  } catch {
    return { birthdays: {}, hourBefore: {}, siteConfirmed: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2), 'utf8');
}

function pruneOldEntries(state) {
  const cutoff7d  = Date.now() - 7   * 24 * 60 * 60 * 1000;
  const cutoff90d = Date.now() - 90  * 24 * 60 * 60 * 1000;
  const cutoff1y  = Date.now() - 366 * 24 * 60 * 60 * 1000;

  for (const key of Object.keys(state.hourBefore || {})) {
    if ((state.hourBefore[key].sentAt || 0) < cutoff7d)
      delete state.hourBefore[key];
  }
  for (const key of Object.keys(state.birthdays || {})) {
    if ((state.birthdays[key].sentAt || 0) < cutoff1y)
      delete state.birthdays[key];
  }
  for (const key of Object.keys(state.siteConfirmed || {})) {
    if ((state.siteConfirmed[key].sentAt || 0) < cutoff90d)
      delete state.siteConfirmed[key];
  }
  return state;
}

function normalizePhone(raw) {
  return String(raw || '').replace(/\D/g, '');
}

// ─── Lembrete antes da consulta ───────────────────────────────────────────────

function wasHourBeforeSent(rowIndex, data) {
  const state = loadState();
  return !!(state.hourBefore[`${rowIndex}__${data}`]);
}

function markHourBeforeSent(rowIndex, data, nome) {
  // BUG-F: usa fila para evitar escrita simultanea
  return enqueueWrite(() => {
    const state = pruneOldEntries(loadState());
    state.hourBefore[`${rowIndex}__${data}`] = { nome, sentAt: Date.now() };
    saveState(state);
  });
}

// ─── Aniversario ─────────────────────────────────────────────────────────────

function wasBirthdaySentThisYear(telefone) {
  const state = loadState();
  const key   = `${normalizePhone(telefone)}__${new Date().getFullYear()}`;
  return !!(state.birthdays[key]);
}

function markBirthdaySent(telefone, nome) {
  return enqueueWrite(() => {
    const state = pruneOldEntries(loadState());
    const key   = `${normalizePhone(telefone)}__${new Date().getFullYear()}`;
    state.birthdays[key] = { nome, sentAt: Date.now() };
    saveState(state);
  });
}

// ─── Confirmacao do site ──────────────────────────────────────────────────────
// Chave composta rowIndex + telefone — evita bloquear nova linha com mesmo rowIndex

function wasSiteConfirmationSent(rowIndex, telefone) {
  const state = loadState();
  const key   = `${rowIndex}__${normalizePhone(telefone)}`;
  return !!(state.siteConfirmed[key]);
}

function markSiteConfirmationSent(rowIndex, telefone, nome) {
  return enqueueWrite(() => {
    const state = pruneOldEntries(loadState());
    const key   = `${rowIndex}__${normalizePhone(telefone)}`;
    state.siteConfirmed[key] = { nome, sentAt: Date.now() };
    saveState(state);
  });
}

module.exports = {
  wasHourBeforeSent,
  markHourBeforeSent,
  wasBirthdaySentThisYear,
  markBirthdaySent,
  wasSiteConfirmationSent,
  markSiteConfirmationSent,
};