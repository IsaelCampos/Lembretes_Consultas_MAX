// src/whatsapp.js
// Gerencia a conexao WhatsApp e o fluxo de resposta SIM/NAO

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const log    = require('electron-log');
const { app } = require('electron');
const path   = require('path');

let client   = null;
let isReady  = false;

const pendingConfirmations = new Map();
const processingLock       = new Set();

function sessionPath() {
  return path.join(app.getPath('userData'), 'wa-session');
}

function emit(channel, data) {
  if (global.sendToRenderer) global.sendToRenderer(channel, data);
}

function emitLog(level, msg) {
  log[level](msg);
  emit('log-message', { level, msg, time: new Date().toLocaleTimeString('pt-BR') });
}

function normalizePhone(raw) {
  return String(raw || '').replace(/\D/g, '');
}

function toBrazilianNumber(phone) {
  const digits = normalizePhone(phone);
  if (digits.startsWith('55') && digits.length >= 12) return digits;
  return '55' + digits;
}

// BUG 3 e 8 CORRIGIDOS: substituimos once() por on() com guard interno,
// e resetamos o client corretamente para permitir reconexao limpa.
function attachClientEvents() {
  client.on('qr', async (qr) => {
    emitLog('info', 'QR Code gerado — aguardando leitura...');
    try {
      const dataUrl = await qrcode.toDataURL(qr, { width: 280, margin: 2 });
      emit('qr-code', { dataUrl });
      emit('wa-status', { status: 'qr' });
    } catch (err) {
      emitLog('error', 'Erro ao gerar QR Code: ' + err.message);
    }
  });

  // Usa on() em vez de once() para suportar reconexoes sem recriar o client
  client.on('authenticated', () => {
    emitLog('info', 'WhatsApp autenticado.');
    emit('wa-status', { status: 'authenticated' });
  });

  client.on('ready', () => {
    isReady = true;
    const me = client.info?.wid?.user || '?';
    emitLog('info', `WhatsApp conectado. Numero: ${me}`);
    emitLog('info', 'Use os botoes para iniciar o modo de producao ou executar um teste.');
    emit('wa-status', { status: 'ready', number: me });
  });

  client.on('auth_failure', (msg) => {
    isReady = false;
    emitLog('error', 'Falha na autenticacao: ' + msg);
    emit('wa-status', { status: 'auth_failure' });
  });

  client.on('disconnected', (reason) => {
    isReady = false;
    emitLog('warn', 'WhatsApp desconectado: ' + reason);
    emit('wa-status', { status: 'disconnected', reason });
    // Nao zeramos client aqui — deixamos o objeto existir para que o
    // whatsapp-web.js possa tentar reconectar automaticamente via LocalAuth.
    // O guard 'if (client)' em initWhatsApp evita duplicacao.
  });

  client.on('message', async (msg) => {
    if (msg.fromMe || msg.isGroupMsg) return;

    const waId       = msg.from;
    const hasPending = pendingConfirmations.has(waId);

    emitLog('info', `Mensagem recebida de ${waId}: "${msg.body}" | pending: ${hasPending}`);

    if (processingLock.has(waId)) return;

    const pending = pendingConfirmations.get(waId);
    if (!pending) return;

    if (Date.now() > pending.expiresAt) {
      pendingConfirmations.delete(waId);
      return;
    }

    processingLock.add(waId);
    const snapshot = { ...pending };

    const resposta = msg.body.trim().toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    const confirmou = /^(sim|s|yes|1|confirmo|confirmado)$/.test(resposta) || msg.body.trim() === '✅';
    const negou     = /^(nao|no|2|cancelar|remarcar)$/.test(resposta)      || msg.body.trim() === '❌';

    try {
      if (confirmou) {
        pendingConfirmations.delete(waId);
        const texto = `Ótimo, ${snapshot.nome}! Sua presença está confirmada. Te esperamos daqui a pouco!`;
        await client.sendMessage(waId, texto);
        emitLog('info', `OK — ${snapshot.nome} confirmou presenca.`);
        emit('msg-sent', { nome: snapshot.nome, tipo: 'confirmacao_sim', waId });

      } else if (negou) {
        pendingConfirmations.delete(waId);
        const { loadConfig }       = require('./config');
        const { appendToReschedule } = require('./sheets');
        const contato = loadConfig().contactInfo || 'Aguardamos seu retorno.';
        const texto = `Entendemos, ${snapshot.nome}. Por favor, entre em contato para remarcar sua consulta.\n\n${contato}\n\nQualquer duvida, estamos a disposicao!`;
        await client.sendMessage(waId, texto);
        emitLog('info', `REMARCAR — ${snapshot.nome} pediu para remarcar.`);
        emit('msg-sent', { nome: snapshot.nome, tipo: 'confirmacao_nao', waId });
        await appendToReschedule({
          nome:         snapshot.nome,
          telefone:     snapshot.telefone     || '',
          data:         snapshot.data         || '',
          horaCompleta: snapshot.horaCompleta || '',
        });

      } else {
        await client.sendMessage(waId, 'Por favor, responda apenas *SIM* ou *NAO*.');
        emitLog('info', `Resposta nao reconhecida de ${snapshot.nome}: "${msg.body}"`);
      }
    } catch (err) {
      emitLog('error', `Erro ao responder ${waId}: ${err.message}`);
    } finally {
      processingLock.delete(waId);
    }
  });
}

async function initWhatsApp() {
  // Guard: se client ja existe (inclusive apos desconexao), nao recria
  if (client) {
    emitLog('info', 'Cliente WhatsApp ja instanciado.');
    return;
  }

  emitLog('info', 'Iniciando WhatsApp...');
  emit('wa-status', { status: 'connecting' });

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: sessionPath() }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    },
  });

  attachClientEvents();
  client.initialize();
}

async function sendMessage(phone, message) {
  if (!isReady || !client) {
    emitLog('error', 'WhatsApp nao esta pronto.');
    return false;
  }

  const intl = toBrazilianNumber(phone);

  try {
    const numberId = await client.getNumberId(intl);
    if (!numberId) {
      emitLog('warn', `Numero ${intl} nao encontrado no WhatsApp.`);
      return false;
    }
    await client.sendMessage(numberId._serialized, message);
    emitLog('info', `Enviado para ${numberId._serialized}`);
    return numberId._serialized;
  } catch (err) {
    emitLog('error', `Erro ao enviar para ${intl}: ${err.message}`);
    return false;
  }
}

async function checkNumberExists(phone) {
  if (!isReady || !client) return false;
  const intl = toBrazilianNumber(phone);
  try {
    return await client.isRegisteredUser(`${intl}@c.us`);
  } catch {
    return false;
  }
}

function registerPendingConfirmation(waId, data) {
  pendingConfirmations.set(waId, {
    ...data,
    expiresAt: Date.now() + 2 * 60 * 60 * 1000,
  });
  emitLog('info', `Pending registrado para ${waId} (${data.nome})`);
}

function getIsReady() { return isReady; }

module.exports = {
  initWhatsApp,
  sendMessage,
  checkNumberExists,
  registerPendingConfirmation,
  toBrazilianNumber,
  emitLog,
  getIsReady,
};