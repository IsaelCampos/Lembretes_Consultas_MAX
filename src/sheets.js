// src/sheets.js
// Le/escreve nas planilhas do cliente via Google Sheets API

const { google } = require('googleapis');
const fs         = require('fs');
const { loadConfig } = require('./config');
const { emitLog }    = require('./whatsapp');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

function getAuth() {
  const cfg = loadConfig();
  if (!cfg.credentialsPath || !fs.existsSync(cfg.credentialsPath)) {
    throw new Error(
      'Arquivo de credenciais nao encontrado. ' +
      'Va em Configuracoes e selecione o credentials.json.'
    );
  }
  return new google.auth.GoogleAuth({ keyFile: cfg.credentialsPath, scopes: SCOPES });
}

function getSheetId() {
  const cfg = loadConfig();
  if (!cfg.googleSheetId) {
    throw new Error('ID da planilha nao configurado. Va em Configuracoes.');
  }
  return cfg.googleSheetId;
}

function extractStartTime(horaStr) {
  if (!horaStr) return '';
  return String(horaStr).split('-')[0].trim();
}

async function sheetsClient() {
  return google.sheets({ version: 'v4', auth: getAuth() });
}

async function readTab(tabName) {
  const api      = await sheetsClient();
  const response = await api.spreadsheets.values.get({
    spreadsheetId: getSheetId(),
    range: `${tabName}!A:Z`,
  });
  const rows = response.data.values || [];
  return rows.length > 1 ? rows.slice(1) : [];
}

// BUG-G CORRIGIDO: helper de retry com backoff exponencial
async function withRetry(fn, label, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      const waitMs = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
      emitLog('warn', `${label} — tentativa ${attempt} falhou. Tentando novamente em ${waitMs / 1000}s...`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
}

// ─── Aniversario ──────────────────────────────────────────────────────────────
// Colunas: A=NOME, B=PRONTUARIO, C=NASCIMENTO, ..., J=TELEFONE

async function getBirthdayClients() {
  const cfg     = loadConfig();
  const tabName = cfg.birthdayTab || 'Aniversário';
  try {
    emitLog('info', `Lendo aba "${tabName}"...`);
    const rows = await readTab(tabName);
    const clients = rows
      .filter(row => row[9] && row[2])
      .map(row => ({
        nome:           (row[0] || 'Cliente').trim(),
        telefone:       (row[9] || '').trim(),
        dataNascimento: (row[2] || '').trim(),
      }));
    emitLog('info', `${clients.length} clientes na aba de aniversarios.`);
    return clients;
  } catch (err) {
    emitLog('error', `Erro ao ler aba ${tabName}: ${err.message}`);
    throw err;
  }
}

// ─── Agendamentos Manual ──────────────────────────────────────────────────────
// Colunas: A=NOME, B=DATA SESSAO, C=HORARIO (18:00-19:00), D=TELEFONE

async function getAppointments(tabName) {
  const cfg = loadConfig();
  const tab = tabName || cfg.appointmentsTab || 'Agendamentos_Manual';
  try {
    emitLog('info', `Lendo aba "${tab}"...`);
    const rows = await readTab(tab);
    const appointments = rows
      .filter(row => row[3] && row[1])
      .map((row, i) => ({
        rowIndex:     i + 2,
        nome:         (row[0] || 'Cliente').trim(),
        data:         (row[1] || '').trim(),
        horaCompleta: (row[2] || '').trim(),
        horaInicio:   extractStartTime(row[2]),
        telefone:     (row[3] || '').trim(),
      }));
    emitLog('info', `${appointments.length} agendamentos na aba "${tab}".`);
    return appointments;
  } catch (err) {
    emitLog('error', `Erro ao ler aba ${tab}: ${err.message}`);
    throw err;
  }
}

// ─── Agendamentos Site ────────────────────────────────────────────────────────
// Colunas: B=data/hora cadastro, C=Nome, E=Telefone, F=Data Consulta,
//          G=Horario Consulta, J=Status

async function getSiteAppointments() {
  const cfg     = loadConfig();
  const tabName = cfg.siteAppointmentsTab || 'Agendamentos_Site';
  try {
    emitLog('info', `Lendo aba "${tabName}"...`);
    const rows = await readTab(tabName);
    const appointments = rows
      .filter(row => row[4] && row[5])
      .map((row, i) => ({
        rowIndex:     i + 2,
        nome:         (row[2]  || 'Cliente').trim(),
        telefone:     (row[4]  || '').trim(),
        data:         (row[5]  || '').trim(),
        horaCompleta: (row[6]  || '').trim(),
        horaInicio:   extractStartTime(row[6]),
        status:       (row[9]  || '').trim(),
      }));
    emitLog('info', `${appointments.length} agendamentos na aba "${tabName}".`);
    return appointments;
  } catch (err) {
    emitLog('error', `Erro ao ler aba ${tabName}: ${err.message}`);
    throw err;
  }
}

// ─── Remarcar ─────────────────────────────────────────────────────────────────

async function appendToReschedule({ nome, telefone, data, horaCompleta }) {
  const cfg     = loadConfig();
  const tabName = cfg.rescheduleTab || 'Remarcar';

  // BUG-G CORRIGIDO: 3 tentativas com backoff exponencial
  return withRetry(async () => {
    const api   = await sheetsClient();
    const agora = new Date().toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
    await api.spreadsheets.values.append({
      spreadsheetId:    getSheetId(),
      range:            `${tabName}!A:E`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[nome, telefone, data, horaCompleta, agora]] },
    });
    emitLog('info', `${nome} adicionado a aba "${tabName}".`);
    return true;
  }, `appendToReschedule(${nome})`).catch(err => {
    emitLog('error', `Falha ao registrar remarcacao de ${nome} apos 3 tentativas: ${err.message}`);
    return false;
  });
}

module.exports = {
  getAppointments,
  getSiteAppointments,
  getBirthdayClients,
  appendToReschedule,
};