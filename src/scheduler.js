// src/scheduler.js
// Controle do agendador — o usuario decide quando ligar/desligar

const cron = require('node-cron');
const { runHourBeforeReminders, runSiteConfirmations, runBirthdayMessages } = require('./reminder');
const { emitLog } = require('./whatsapp');

let jobs      = [];
let isRunning = false;

function startScheduler() {
  if (isRunning) {
    emitLog('warn', 'Agendador ja esta em execucao.');
    return false;
  }

  const { loadConfig } = require('./config');
  const cfg      = loadConfig();
  const timezone = cfg.timezone            || 'America/Fortaleza';
  const tabManual = cfg.appointmentsTab    || 'Agendamentos_Manual';
  const tabSite   = cfg.siteAppointmentsTab || 'Agendamentos_Site';

  const [bHour, bMin] = (cfg.birthdayTime || '08:00').split(':').map(Number);
  const birthdayCron  = `${bMin} ${bHour} * * *`;

  // Job 1: a cada minuto — lembrete 1h antes (manual)
  const job1 = cron.schedule('* * * * *', async () => {
    emitLog('info', `[${now()}] Verificando agendamentos manuais...`);
    await runHourBeforeReminders(tabManual);
  }, { timezone });

  // Job 2: a cada minuto — lembrete 1h antes (site)
  const job2 = cron.schedule('* * * * *', async () => {
    emitLog('info', `[${now()}] Verificando agendamentos do site...`);
    await runHourBeforeReminders(tabSite);
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
  emitLog('info', `  Agendamentos Manual : "${tabManual}" — verificacao a cada minuto`);
  emitLog('info', `  Agendamentos Site   : "${tabSite}" — verificacao a cada minuto`);
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

// Execucao manual unica — sem tocar no agendador
async function runOnce(tabName) {
  const { loadConfig } = require('./config');
  const cfg      = loadConfig();
  const testTab  = cfg.testTab || 'Teste';
  const isTeste  = tabName === testTab;

  emitLog('info', isTeste
    ? `TESTE — lendo aba "${tabName}"...`
    : `Executando agora — aba "${tabName}"...`
  );

  await runHourBeforeReminders(tabName);

  // No modo producao manual roda tambem confirmacoes do site e aniversarios
  if (!isTeste) {
    await runSiteConfirmations();
    await runBirthdayMessages();
  }

  emitLog('info', 'Execucao manual concluida.');
}

function now() { return new Date().toLocaleString('pt-BR'); }

module.exports = { startScheduler, stopScheduler, getIsRunning, runOnce };