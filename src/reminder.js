// src/reminder.js
// Logica de todos os lembretes

const { parse, isValid, isEqual, startOfDay, differenceInMinutes, format } = require('date-fns');
const { ptBR } = require('date-fns/locale');
const {
  sendMessage, checkNumberExists, registerPendingConfirmation, emitLog, getIsReady,
} = require('./whatsapp');
const { getAppointments, getSiteAppointments, getBirthdayClients } = require('./sheets');
const {
  wasHourBeforeSent, markHourBeforeSent,
  wasBirthdaySentThisYear, markBirthdaySent,
  wasSiteConfirmationSent, markSiteConfirmationSent,
} = require('./state');

// loadConfig no topo do arquivo — sem hoisting trick
const loadConfig = () => require('./config').loadConfig();

// ─── Utilitarios de data ──────────────────────────────────────────────────────

function parseDate(str) {
  if (!str) return null;
  const s = String(str).trim();
  // BUG 5 CORRIGIDO: ordem unica e consistente — dd/MM primeiro para dados
  // brasileiros. Para datas no formato americano (planilha de aniversario),
  // usamos funcao separada isBirthdayToday com ordem correta.
  const fmts = [
    'dd/MM/yy', 'dd/MM/yyyy', 'yyyy-MM-dd',
    'MM/dd/yyyy', 'dd-MM-yyyy',
    'dd/MM/yy HH:mm', 'dd/MM/yyyy HH:mm',
    'yyyy-MM-dd HH:mm:ss',
  ];
  for (const fmt of fmts) {
    const d = parse(s, fmt, new Date());
    if (isValid(d)) return startOfDay(d);
  }
  const native = new Date(s);
  if (isValid(native)) return startOfDay(native);
  return null;
}

function isToday(date) {
  return isEqual(startOfDay(date), startOfDay(new Date()));
}

function buildDateTime(dataStr, horaStr) {
  const base = parseDate(dataStr);
  if (!base) return null;
  if (!horaStr || !horaStr.includes(':')) return base;
  const [h, m] = horaStr.trim().split(':').map(Number);
  const dt = new Date(base);
  dt.setHours(h || 0, m || 0, 0, 0);
  return dt;
}

// BUG 5 CORRIGIDO: isBirthdayToday usa MM/dd/yyyy PRIMEIRO porque a aba
// Aniversario exporta no formato americano (ex: "11/14/2006").
// Separado de parseDate() que lida com datas de agendamentos (formato BR).
function isBirthdayToday(dateStr) {
  if (!dateStr) return false;
  const s   = String(dateStr).trim();
  const now = new Date();
  // Formato americano primeiro (exportacao do Google Sheets)
  const fmts = ['MM/dd/yyyy', 'MM/dd/yy', 'dd/MM/yyyy', 'dd/MM/yy', 'MM/dd', 'dd/MM'];
  for (const fmt of fmts) {
    const d = parse(s, fmt, new Date());
    if (isValid(d)) {
      return d.getDate() === now.getDate() && d.getMonth() === now.getMonth();
    }
  }
  return false;
}

function fmtData(dataStr) {
  const d = parseDate(dataStr);
  return d ? format(d, "dd 'de' MMMM 'de' yyyy", { locale: ptBR }) : dataStr;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── 1. Lembrete 1h antes ────────────────────────────────────────────────────

async function runHourBeforeReminders(tabName) {
  if (!getIsReady()) {
    emitLog('warn', 'WhatsApp nao esta pronto — pulando verificacao de 1h antes.');
    return;
  }

  const cfg       = loadConfig();
  const siteTab   = cfg.siteAppointmentsTab || 'Agendamentos_Site';
  const isSiteTab = tabName === siteTab;

  emitLog('info', `Verificando consultas em ~1h na aba "${tabName}"...`);

  let appointments;
  try {
    appointments = isSiteTab
      ? await getSiteAppointments()
      : await getAppointments(tabName);
  } catch (err) {
    emitLog('error', 'Erro ao buscar agendamentos: ' + err.message);
    return;
  }

  const now      = new Date();
  const proximas = appointments.filter(a => {
    const dt = buildDateTime(a.data, a.horaInicio);
    if (!dt || !isToday(dt)) return false;
    const diff = differenceInMinutes(dt, now);
    return diff >= 55 && diff <= 75;
  });

  emitLog('info', `Consultas em ~1h: ${proximas.length}`);

  for (const a of proximas) {
    if (wasHourBeforeSent(a.rowIndex, a.data)) {
      emitLog('info', `IGNORADO — lembrete 1h ja enviado para ${a.nome} (${a.data}).`);
      continue;
    }

    emitLog('info', `Enviando lembrete 1h para ${a.nome} | ${a.telefone} | ${a.horaCompleta}`);

    const exists = await checkNumberExists(a.telefone);
    if (!exists) {
      emitLog('warn', `Numero sem WhatsApp: ${a.telefone} (${a.nome})`);
      continue;
    }

    const msg =
      `Ola, ${a.nome}!\n\n` +
      `Sua consulta esta marcada para *hoje as ${a.horaInicio}*.\n\n` +
      `Voce esta ciente e vai comparecer? Lembramos que *faltas nao justificadas estao sujeitas a cobranca*.\n\n` +
      `Responda:\n` +
      `*SIM* — estou confirmado\n` +
      `*NAO* — preciso remarcar`;

    const waId = await sendMessage(a.telefone, msg);

    if (waId) {
      markHourBeforeSent(a.rowIndex, a.data, a.nome);
      registerPendingConfirmation(waId, {
        nome: a.nome, telefone: a.telefone,
        data: a.data, horaCompleta: a.horaCompleta,
      });
      global.sendToRenderer?.('msg-sent', {
        nome: a.nome, tipo: '1h_antes', hora: a.horaInicio, data: a.data,
      });
    }

    await sleep(1500);
  }
}

// ─── 2. Confirmacao de agendamento do site ────────────────────────────────────

async function runSiteConfirmations() {
  if (!getIsReady()) {
    emitLog('warn', 'WhatsApp nao esta pronto — pulando confirmacoes do site.');
    return;
  }

  const cfg            = loadConfig();
  const statusEsperado = (cfg.siteConfirmedStatus || 'confirmado').toLowerCase().trim();

  emitLog('info', `Verificando confirmacoes na aba "${cfg.siteAppointmentsTab || 'Agendamentos_Site'}"...`);

  let appointments;
  try {
    appointments = await getSiteAppointments();
  } catch (err) {
    emitLog('error', 'Erro ao buscar agendamentos do site: ' + err.message);
    return;
  }

  const confirmados = appointments.filter(a =>
    a.status.toLowerCase().trim() === statusEsperado
  );

  emitLog('info', `Agendamentos com status "${statusEsperado}": ${confirmados.length}`);

  for (const a of confirmados) {
    // BUG 4 CORRIGIDO: passa telefone como segundo argumento para chave composta
    if (wasSiteConfirmationSent(a.rowIndex, a.telefone)) {
      emitLog('info', `IGNORADO — confirmacao ja enviada para ${a.nome} (linha ${a.rowIndex}).`);
      continue;
    }

    emitLog('info', `Enviando confirmacao para ${a.nome} | ${a.telefone}`);

    const exists = await checkNumberExists(a.telefone);
    if (!exists) {
      emitLog('warn', `Numero sem WhatsApp: ${a.telefone} (${a.nome})`);
      continue;
    }

    const msg =
      `Prezado(a) ${a.nome},\n\n` +
      `Informamos que o seu agendamento e o comprovante de pagamento foram recebidos e confirmados com sucesso.\n\n` +
      `Segue o resumo da sua consulta:\n` +
      `Data: ${fmtData(a.data)}\n` +
      `Horario: ${a.horaInicio}\n\n` +
      `Caso tenha alguma duvida ou necessite de informacoes adicionais, nao hesite em nos contatar.\n\n` +
      `Atenciosamente,\n` +
      `Equipe de Atendimento`;

    const waId = await sendMessage(a.telefone, msg);

    if (waId) {
      // BUG 4 CORRIGIDO: passa telefone para chave composta
      markSiteConfirmationSent(a.rowIndex, a.telefone, a.nome);
      global.sendToRenderer?.('msg-sent', { nome: a.nome, tipo: 'confirmacao_site', data: a.data });
    }

    await sleep(1500);
  }
}

// ─── 3. Aniversarios ─────────────────────────────────────────────────────────

async function runBirthdayMessages() {
  if (!getIsReady()) {
    emitLog('warn', 'WhatsApp nao esta pronto — pulando aniversarios.');
    return;
  }

  emitLog('info', 'Verificando aniversariantes...');

  let clients;
  try {
    clients = await getBirthdayClients();
  } catch (err) {
    emitLog('error', 'Erro ao buscar clientes: ' + err.message);
    return;
  }

  const aniversariantes = clients.filter(c => isBirthdayToday(c.dataNascimento));
  emitLog('info', `Aniversariantes hoje: ${aniversariantes.length}`);

  for (const c of aniversariantes) {
    if (wasBirthdaySentThisYear(c.telefone)) {
      emitLog('info', `IGNORADO — parabens ja enviado este ano para ${c.nome}.`);
      continue;
    }

    emitLog('info', `Enviando parabens para ${c.nome} | ${c.telefone}`);

    const exists = await checkNumberExists(c.telefone);
    if (!exists) {
      emitLog('warn', `Numero sem WhatsApp: ${c.telefone} (${c.nome})`);
      continue;
    }

    const msg =
      `Feliz Aniversario, ${c.nome}! 🎂\n\n` +
      `Desejamos a voce um dia muito especial, repleto de alegrias e conquistas!\n\n` +
      `Com carinho, Maxwell`;

    const waId = await sendMessage(c.telefone, msg);

    if (waId) {
      markBirthdaySent(c.telefone, c.nome);
      global.sendToRenderer?.('msg-sent', { nome: c.nome, tipo: 'aniversario' });
    }

    await sleep(1500);
  }
}

module.exports = { runHourBeforeReminders, runSiteConfirmations, runBirthdayMessages };