// src/whatsapp.js
// Gerencia conexao WhatsApp e fluxo de resposta SIM/NAO

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const log = require('electron-log');
const { app } = require('electron');
const path = require('path');

let client = null;
let isReady = false;
let cleanupTimer = null;

const pendingConfirmations = new Map();
const processingLock = new Set();

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

// Wrapper de timeout para operacoes que podem travar.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout (${ms}ms): ${label}`)), ms)
    ),
  ]);
}

function startPendingCleanup() {
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    let removed = 0;

    for (const [waId, pending] of pendingConfirmations) {
      if (now > pending.expiresAt) {
        pendingConfirmations.delete(waId);
        removed++;
      }
    }

    if (removed > 0) emitLog('info', `Limpeza: ${removed} pending(s) expirado(s) removido(s).`);
  }, 30 * 60 * 1000);
}

function attachClientEvents() {
  client.on('qr', async (qr) => {
    emitLog('info', 'QR Code gerado - aguardando leitura...');
    try {
      const dataUrl = await qrcode.toDataURL(qr, { width: 280, margin: 2 });
      emit('qr-code', { dataUrl });
      emit('wa-status', { status: 'qr' });
    } catch (err) {
      emitLog('error', 'Erro ao gerar QR Code: ' + err.message);
    }
  });

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
  });

  client.on('message', async (msg) => {
    if (msg.fromMe || msg.isGroupMsg) return;

    const waId = msg.from;
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
    const negou = /^(nao|no|2|cancelar|remarcar)$/.test(resposta) || msg.body.trim() === '❌';

    try {
      if (confirmou) {
        pendingConfirmations.delete(waId);

        const dataConsulta = snapshot.data || 'data nao informada';
        const horarioConsulta = snapshot.horaCompleta || 'horario nao informado';
        const texto =
          `Otimo, ${snapshot.nome}! Sua presenca esta confirmada. Te esperamos daqui a pouco!\n\n` +
          `Esta quase na hora da sua consulta! Vamos garantir que tudo esteja pronto.\n` +
          `Aqui estao os detalhes:\n\n` +
          `Consulta com: Maxwell Soares\n` +
          `Data: ${dataConsulta}\n` +
          `Horario: ${horarioConsulta}\n\n` +
          `Aqui estao algumas dicas para uma experiencia incrivel:\n\n` +
          `- Encontre um cantinho tranquilo e com boa iluminacao.\n` +
          `- Teste sua conexao de internet, camera e microfone antes da consulta.\n` +
          `- Use fones de ouvido para maior privacidade e melhor qualidade de audio.\n` +
          `- E o mais importante: relaxe! Estamos aqui para cuidar de voce.\n\n` +
          `Caso tenha alguma duvida ou necessite de informacoes adicionais, nao hesite em nos contatar.\n\n` +
          `Atenciosamente,\n` +
          `Equipe de Atendimento`;

        await client.sendMessage(waId, texto);
        emitLog('info', `OK - ${snapshot.nome} confirmou presenca.`);
        emit('msg-sent', { nome: snapshot.nome, tipo: 'confirmacao_sim', waId });
      } else if (negou) {
        pendingConfirmations.delete(waId);
        const { loadConfig } = require('./config');
        const { appendToReschedule } = require('./sheets');
        const contato = loadConfig().contactInfo || 'aguardamos seu contato';
        const texto =
          `Entendemos, ${snapshot.nome}. ` +
          `Por favor, entre em contato para remarcar sua consulta.\n\n${contato}\n\n` +
          `Qualquer duvida, estamos a disposicao!`;

        await client.sendMessage(waId, texto);
        emitLog('info', `REMARCAR - ${snapshot.nome} pediu para remarcar.`);
        emit('msg-sent', { nome: snapshot.nome, tipo: 'confirmacao_nao', waId });

        await appendToReschedule({
          nome: snapshot.nome,
          telefone: snapshot.telefone || '',
          data: snapshot.data || '',
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
  startPendingCleanup();
  client.initialize();
}

async function shutdownWhatsApp() {
  if (!client) return;

  const currentClient = client;
  client = null;
  isReady = false;

  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }

  try {
    await withTimeout(currentClient.destroy(), 15_000, 'client.destroy()');
    emitLog('info', 'Cliente WhatsApp finalizado com sucesso.');
  } catch (err) {
    emitLog('warn', `Falha ao finalizar cliente WhatsApp: ${err.message}`);
  }
}

async function sendMessage(phone, message) {
  if (!isReady || !client) {
    emitLog('error', 'WhatsApp nao esta pronto.');
    return false;
  }

  const intl = toBrazilianNumber(phone);

  try {
    const numberId = await withTimeout(
      client.getNumberId(intl),
      15_000,
      `getNumberId(${intl})`
    );

    if (!numberId) {
      emitLog('warn', `Numero ${intl} nao encontrado no WhatsApp.`);
      return false;
    }

    await withTimeout(
      client.sendMessage(numberId._serialized, message),
      15_000,
      `sendMessage(${intl})`
    );

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
    return await withTimeout(
      client.isRegisteredUser(`${intl}@c.us`),
      10_000,
      `isRegisteredUser(${intl})`
    );
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

function getIsReady() {
  return isReady;
}

module.exports = {
  initWhatsApp,
  shutdownWhatsApp,
  sendMessage,
  checkNumberExists,
  registerPendingConfirmation,
  toBrazilianNumber,
  emitLog,
  getIsReady,
};
