// src/whatsapp.js
// Gerencia a conexão WhatsApp e o fluxo de resposta SIM/NÃO

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const log = require('electron-log');
const { app } = require('electron');
const path = require('path');

let client = null;
let isReady = false;

// Mapa: waId (msg.from) → { nome, expiresAt }
const pendingConfirmations = new Map();
const processingLock = new Set();

// Caminho para salvar a sessão dentro do userData do Electron
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

/**
 * Converte telefone da planilha para formato internacional brasileiro
 * "(89) 9465-2125" → "5589946521225"
 * Já com DDI: "5589946521225" → mantém
 */
function toBrazilianNumber(phone) {
  const digits = normalizePhone(phone);
  // Já tem DDI 55
  if (digits.startsWith('55') && digits.length >= 12) return digits;
  // Adiciona DDI 55
  return '55' + digits;
}

async function initWhatsApp() {
  if (client) return;

  emitLog('info', 'Iniciando WhatsApp...');
  emit('wa-status', { status: 'connecting' });

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: sessionPath() }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    },
  });

  client.on('qr', async (qr) => {
    emitLog('info', 'QR Code gerado — aguardando leitura...');
    try {
      // Gera QR como Data URL para exibir na interface
      const dataUrl = await qrcode.toDataURL(qr, { width: 280, margin: 2 });
      emit('qr-code', { dataUrl });
      emit('wa-status', { status: 'qr' });
    } catch (err) {
      emitLog('error', 'Erro ao gerar QR Code: ' + err.message);
    }
  });

  client.once('authenticated', () => {
    emitLog('info', 'WhatsApp autenticado.');
    emit('wa-status', { status: 'authenticated' });
  });

  client.once('ready', () => {
    isReady = true;
    const me = client.info?.wid?.user || '?';
    emitLog('info', `WhatsApp conectado. Numero: ${me}`);
    emitLog('info', `Use os botoes para iniciar o modo de producao ou executar um teste.`);
    emit('wa-status', { status: 'ready', number: me });
    // O agendador NÃO inicia automaticamente — o usuário escolhe via botão
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
    client = null;
  });

  // ── Listener de respostas SIM/NÃO ─────────────────────────────────────────
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
    const negou     = /^(nao|no|2|cancelar|remarcar)$/.test(resposta)      || msg.body.trim() === '❌';

    try {
      if (confirmou) {
        pendingConfirmations.delete(waId);
        const texto = 'Ótimo, {nome}! 🎉 Sua presença está confirmada. Te esperamos daqui a pouco! 🕐'
          .replace('{nome}', snapshot.nome);
        await client.sendMessage(waId, texto);
        emitLog('info', `OK — ${snapshot.nome} confirmou presença.`);
        emit('msg-sent', { nome: snapshot.nome, tipo: 'confirmacao_sim', waId });

      } else if (negou) {
        pendingConfirmations.delete(waId);
        const { loadConfig } = require('./config');
        const { appendToReschedule } = require('./sheets');
        const contato = loadConfig().contactInfo || 'Aguardamos seu retorno.';
        const texto = `Entendemos, ${snapshot.nome}. Por favor, entre em contato para remarcar sua consulta.\n\n📞 ${contato}\n\nQualquer dúvida, estamos à disposição! 😊`;
        await client.sendMessage(waId, texto);
        emitLog('info', `REMARCAR — ${snapshot.nome} pediu para remarcar.`);
        emit('msg-sent', { nome: snapshot.nome, tipo: 'confirmacao_nao', waId });

        // Grava na aba "Remarcar" da planilha
        await appendToReschedule({
          nome:        snapshot.nome,
          telefone:    snapshot.telefone    || '',
          data:        snapshot.data        || '',
          horaCompleta: snapshot.horaCompleta || '',
        });

      } else {
        await client.sendMessage(waId, 'Por favor, responda apenas *SIM* ou *NÃO*. 😊');
        emitLog('info', `Resposta nao reconhecida de ${snapshot.nome}: "${msg.body}"`);
      }
    } catch (err) {
      emitLog('error', `Erro ao responder ${waId}: ${err.message}`);
    } finally {
      processingLock.delete(waId);
    }
  });

  client.initialize();
}

/**
 * Envia mensagem — retorna o waId real ou false
 */
async function sendMessage(phone, message) {
  if (!isReady || !client) {
    emitLog('error', 'WhatsApp nao esta pronto.');
    return false;
  }

  const intl = toBrazilianNumber(phone);

  try {
    const numberId = await client.getNumberId(intl);
    if (!numberId) {
      emitLog('warn', `Numero ${intl} não encontrado no WhatsApp.`);
      return false;
    }
    await client.sendMessage(numberId._serialized, message);
    emitLog('info', `Enviado para ${numberId._serialized}`);
    return numberId._serialized; // waId real para registrar pending
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