// src/scheduler.js

const cron = require('node-cron');
const { runHourBeforeReminders, runSiteConfirmations, runBirthdayMessages } = require('./reminder');
const { emitLog } = require('./whatsapp');

let jobs      = [];
let isRunning = false;

// Guarda para evitar execucoes sobrepostas do mesmo job
let runningManual = false;
let runningSite   = false;

function startScheduler() {
  if (isRunning) {
    emitLog('warn', 'Agendador ja esta em execucao.');
    return false;
  }

  const { loadConfig } = require('./config');
  const cfg       = loadConfig();
  const timezone  = cfg.timezone             || 'America/Fortaleza';
  const tabManual = cfg.appointmentsTab      || 'Agendamentos_Manual';
  const tabSite   = cfg.siteAppointmentsTab  || 'Agendamentos_Site';

  const [bHour, bMin] = (cfg.birthdayTime || '09:00').split(':').map(Number);
  const birthdayCron  = `${bMin} ${bHour} * * *`; // cron: minuto hora * * *

  // BUG 1 CORRIGIDO: Jobs 1 e 2 nao mais rodam no mesmo segundo.
  // Job 1 roda nos minutos pares, Job 2 nos minutos impares —
  // elimina race condition e dobro de chamadas a API.
  const job1 = cron.schedule('0/2 * * * *', async () => {
    if (runningManual) return; // guarda contra sobreposicao
    runningManual = true;
    emitLog('info', `[${now()}] Verificando agendamentos manuais...`);
    try { await runHourBeforeReminders(tabManual); }
    finally { runningManual = false; }
  }, { timezone });

  const job2 = cron.schedule('1/2 * * * *', async () => {
    if (runningSite) return;
    runningSite = true;
    emitLog('info', `[${now()}] Verificando agendamentos do site...`);
    try { await runHourBeforeReminders(tabSite); }
    finally { runningSite = false; }
  }, { timezone });

  // Job 3: a cada 5 min — confirmacoes de status do site
  const job3 = cron.schedule('*/5 * * * *', async () => {
    emitLog('info', `[${now()}] Verificando confirmacoes do site...`);
    await runSiteConfirmations();
  }, { timezone });

  // Job 4: horario configurado — aniversarios
  const job4 = cron.schedule(birthdayCron, async () => {
    emitLog('info', `[${now()}] Verificando aniversariantes...`);
    await runBirthdayMessages();
  }, { timezone });

  jobs      = [job1, job2, job3, job4];
  isRunning = true;

  emitLog('info', 'Modo PRODUCAO ligado.');
  emitLog('info', `  Agendamentos Manual : "${tabManual}" — minutos pares`);
  emitLog('info', `  Agendamentos Site   : "${tabSite}" — minutos impares`);
  emitLog('info', `  Confirmacoes Site   : a cada 5 minutos`);
  emitLog('info', `  Aniversarios        : ${cfg.birthdayTime || '09:00'} | Fuso: ${timezone}`);

  return true;
}

function stopScheduler() {
  if (!isRunning) {
    emitLog('warn', 'Agendador ja esta desligado.');
    return false;
  }
  jobs.forEach(j => j.stop());
  jobs      = [];
  isRunning = false;
  emitLog('info', 'Modo PRODUCAO desligado.');
  return true;
}

function getIsRunning() { return isRunning; }

// BUG 2 CORRIGIDO: runOnce agora executa AMBAS as abas (manual + site),
// nao apenas a aba manual que era passada pelo botao.
async function runOnce(tabName) {
  const { loadConfig } = require('./config');
  const cfg      = loadConfig();
  const testTab  = cfg.testTab || 'Teste';
  const isTeste  = tabName === testTab;

  if (isTeste) {
    emitLog('info', `TESTE — lendo aba "${tabName}"...`);
    await runHourBeforeReminders(tabName);
  } else {
    emitLog('info', 'Executando agora — todas as abas...');
    const tabManual = cfg.appointmentsTab     || 'Agendamentos_Manual';
    const tabSite   = cfg.siteAppointmentsTab || 'Agendamentos_Site';
    await runHourBeforeReminders(tabManual);
    await runHourBeforeReminders(tabSite);
    await runSiteConfirmations();
    await runBirthdayMessages();
  }

  emitLog('info', 'Execucao manual concluida.');
}

function now() { return new Date().toLocaleString('pt-BR'); }

module.exports = { startScheduler, stopScheduler, getIsRunning, runOnce };