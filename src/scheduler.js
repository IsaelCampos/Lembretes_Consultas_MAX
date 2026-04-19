// src/scheduler.js

const cron = require('node-cron');
const { runHourBeforeReminders, runSiteConfirmations, runBirthdayMessages } = require('./reminder');
const { emitLog } = require('./whatsapp');

let jobs          = [];
let isRunning     = false;
let runningManual = false;
let runningSite   = false;
let runningConfirmations = false;
let runningBirthdays     = false;

// BUG-D CORRIGIDO: valida e normaliza o horario antes de construir a expressao cron
function buildBirthdayCron(birthdayTime) {
  const str = String(birthdayTime || '09:00');
  const match = str.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    emitLog('warn', `Horario de aniversario invalido "${str}" — usando padrao 09:00.`);
    return '0 9 * * *';
  }
  const h = Math.min(23, Math.max(0, parseInt(match[1], 10)));
  const m = Math.min(59, Math.max(0, parseInt(match[2], 10)));
  return `${m} ${h} * * *`;
}

function startScheduler() {
  if (isRunning) {
    emitLog('warn', 'Agendador ja esta em execucao.');
    return false;
  }

  const { loadConfig } = require('./config');
  const cfg       = loadConfig();
  const timezone  = cfg.timezone            || 'America/Fortaleza';
  const tabManual = cfg.appointmentsTab     || 'Agendamentos_Manual';
  const tabSite   = cfg.siteAppointmentsTab || 'Agendamentos_Site';

  // BUG-D CORRIGIDO: usa funcao segura para construir o cron
  const birthdayCron = buildBirthdayCron(cfg.birthdayTime);

  const job1 = cron.schedule('* * * * *', async () => {
    if (runningManual) return;
    runningManual = true;
    emitLog('info', `[${now()}] Verificando agendamentos manuais...`);
    try { await runHourBeforeReminders(tabManual); }
    finally { runningManual = false; }
  }, { timezone });

  const job2 = cron.schedule('* * * * *', async () => {
    if (runningSite) return;
    runningSite = true;
    emitLog('info', `[${now()}] Verificando agendamentos do site...`);
    try { await runHourBeforeReminders(tabSite); }
    finally { runningSite = false; }
  }, { timezone });

  const job3 = cron.schedule('*/5 * * * *', async () => {
    if (runningConfirmations) return;
    runningConfirmations = true;
    emitLog('info', `[${now()}] Verificando confirmacoes do site...`);
    try { await runSiteConfirmations(); }
    finally { runningConfirmations = false; }
  }, { timezone });

  const job4 = cron.schedule(birthdayCron, async () => {
    if (runningBirthdays) return;
    runningBirthdays = true;
    emitLog('info', `[${now()}] Verificando aniversariantes...`);
    try { await runBirthdayMessages(); }
    finally { runningBirthdays = false; }
  }, { timezone });

  jobs      = [job1, job2, job3, job4];
  isRunning = true;

  const target = cfg.reminderMinutes       || 60;
  const window = cfg.reminderWindowMinutes || 10;

  emitLog('info', 'Modo PRODUCAO ligado.');
  emitLog('info', `  Agendamentos Manual  : "${tabManual}" — a cada minuto`);
  emitLog('info', `  Agendamentos Site    : "${tabSite}" — a cada minuto`);
  emitLog('info', `  Lembrete             : ${target}min antes (±${window}min)`);
  emitLog('info', `  Confirmacoes Site    : a cada 5 minutos`);
  emitLog('info', `  Aniversarios         : ${cfg.birthdayTime || '09:00'} | Fuso: ${timezone}`);

  return true;
}

function stopScheduler() {
  if (!isRunning) {
    emitLog('warn', 'Agendador ja esta desligado.');
    return false;
  }
  jobs.forEach(j => j.stop());
  jobs          = [];
  isRunning     = false;
  runningManual = false;
  runningSite   = false;
  runningConfirmations = false;
  runningBirthdays     = false;
  emitLog('info', 'Modo PRODUCAO desligado.');
  return true;
}

function getIsRunning() { return isRunning; }

async function runOnce(tabName) {
  const { loadConfig } = require('./config');
  const cfg     = loadConfig();
  const testTab = cfg.testTab || 'Teste';
  const isTeste = tabName === testTab;

  if (isTeste) {
    emitLog('info', `TESTE — lendo aba "${tabName}"...`);
    await runHourBeforeReminders(tabName);
  } else {
    emitLog('info', 'Executando agora — todas as abas...');
    await runHourBeforeReminders(cfg.appointmentsTab     || 'Agendamentos_Manual');
    await runHourBeforeReminders(cfg.siteAppointmentsTab || 'Agendamentos_Site');
    await runSiteConfirmations();
    await runBirthdayMessages();
  }

  emitLog('info', 'Execucao manual concluida.');
}

function now() { return new Date().toLocaleString('pt-BR'); }

module.exports = { startScheduler, stopScheduler, getIsRunning, runOnce };
