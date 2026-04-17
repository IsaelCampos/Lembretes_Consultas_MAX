// src/ui/renderer.js
const $ = id => document.getElementById(id);

let statSent = 0, statErrors = 0, statBirthday = 0, statConfirm = 0;
let prodRunning = false;

// ─── Tabs ─────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    $('tab-' + tab.dataset.tab).classList.add('active');
  });
});

// ─── Botoes principais ────────────────────────────────────────────────────────
$('btn-connect').addEventListener('click', async () => {
  $('btn-connect').disabled    = true;
  $('btn-connect').textContent = '⏳ Conectando...';
  await window.api.startWhatsApp();
});

$('btn-toggle-prod').addEventListener('click', async () => {
  const btn = $('btn-toggle-prod');
  btn.disabled = true;

  if (!prodRunning) {
    const ok = await window.api.startScheduler();
    if (ok) {
      prodRunning          = true;
      btn.className        = 'btn btn-red';
      btn.textContent      = '🔴 Desligar Produção';
      addLog('info', 'Modo PRODUCAO ligado.');
    }
  } else {
    const ok = await window.api.stopScheduler();
    if (ok) {
      prodRunning          = false;
      btn.className        = 'btn btn-green';
      btn.textContent      = '🟢 Ligar Produção';
      addLog('info', 'Modo PRODUCAO desligado.');
      $('last-check').textContent = '—';
    }
  }
  btn.disabled = false;
});

$('btn-run-now').addEventListener('click', async () => {
  $('btn-run-now').disabled = true;
  addLog('info', 'Executando agora — todas as abas...');
  await window.api.runNow('__all__');
  $('btn-run-now').disabled = false;
});

$('btn-run-test').addEventListener('click', async () => {
  const cfg = await window.api.getConfig();
  const tab = cfg.testTab || 'Teste';
  $('btn-run-test').disabled = true;
  addLog('info', `TESTE — lendo aba "${tab}"...`);
  await window.api.runNow(tab);
  $('btn-run-test').disabled = false;
});

$('btn-logs').addEventListener('click', () => window.api.openLogs());

// ─── Configuracoes ────────────────────────────────────────────────────────────
document.querySelector('[data-tab="config"]').addEventListener('click', loadConfigIntoForm);

async function loadConfigIntoForm() {
  const cfg = await window.api.getConfig();
  $('cfg-sheet-id').value          = cfg.googleSheetId          || '';
  $('cfg-creds-path').value        = cfg.credentialsPath        || '';
  $('cfg-tab-appt').value          = cfg.appointmentsTab        || 'Agendamentos_Manual';
  $('cfg-tab-site').value          = cfg.siteAppointmentsTab    || 'Agendamentos_Site';
  $('cfg-tab-bday').value          = cfg.birthdayTab            || 'Aniversário';
  $('cfg-tab-test').value          = cfg.testTab                || 'Teste';
  $('cfg-tab-reschedule').value    = cfg.rescheduleTab          || 'Remarcar';
  $('cfg-site-status').value       = cfg.siteConfirmedStatus    || 'confirmado';
  $('cfg-bday-time').value         = cfg.birthdayTime           || '09:00';
  $('cfg-contact').value           = cfg.contactInfo            || '';
  $('cfg-reminder-min').value      = cfg.reminderMinutes        ?? 60;
  $('cfg-reminder-window').value   = cfg.reminderWindowMinutes  ?? 10;
}

$('btn-pick-creds').addEventListener('click', async () => {
  const filePath = await window.api.pickCredentials();
  if (filePath) $('cfg-creds-path').value = filePath;
});

$('btn-save-config').addEventListener('click', async () => {
  const btn = $('btn-save-config');
  btn.disabled    = true;
  btn.textContent = '⏳ Salvando...';

  const cfg = {
    googleSheetId:          $('cfg-sheet-id').value.trim(),
    credentialsPath:        $('cfg-creds-path').value.trim(),
    appointmentsTab:        $('cfg-tab-appt').value.trim()       || 'Agendamentos_Manual',
    siteAppointmentsTab:    $('cfg-tab-site').value.trim()       || 'Agendamentos_Site',
    birthdayTab:            $('cfg-tab-bday').value.trim()       || 'Aniversário',
    testTab:                $('cfg-tab-test').value.trim()       || 'Teste',
    rescheduleTab:          $('cfg-tab-reschedule').value.trim() || 'Remarcar',
    siteConfirmedStatus:    $('cfg-site-status').value.trim()    || 'confirmado',
    birthdayTime:           $('cfg-bday-time').value.trim()      || '09:00',
    contactInfo:            $('cfg-contact').value.trim(),
    reminderMinutes:        Number($('cfg-reminder-min').value)    || 60,
    reminderWindowMinutes:  Number($('cfg-reminder-window').value) || 10,
  };

  const status = $('config-status');

  // Validacao client-side basica
  if (!cfg.googleSheetId) {
    showConfigStatus('error', 'Informe o ID da planilha.');
    btn.disabled = false; btn.textContent = '💾 Salvar Configurações'; return;
  }
  if (!cfg.credentialsPath) {
    showConfigStatus('error', 'Selecione o arquivo credentials.json.');
    btn.disabled = false; btn.textContent = '💾 Salvar Configurações'; return;
  }

  // BUG-C: validacao final feita no main process
  const result = await window.api.saveConfig(cfg);

  if (!result.ok) {
    showConfigStatus('error', result.errors.join(' | '));
  } else {
    showConfigStatus('ok', 'Configurações salvas com sucesso!');
    addLog('info', 'Configuracoes atualizadas.');
  }

  btn.disabled = false; btn.textContent = '💾 Salvar Configurações';
});

function showConfigStatus(type, msg) {
  const el = $('config-status');
  el.className    = `config-status ${type}`;
  el.textContent  = type === 'ok' ? `✅ ${msg}` : `❌ ${msg}`;
  setTimeout(() => el.className = 'config-status', 5000);
}

// ─── Status WhatsApp ──────────────────────────────────────────────────────────
window.api.onWaStatus(({ status, number }) => {
  const badge = $('wa-badge');
  const text  = $('wa-status-text');
  badge.className = 'status-badge';

  const map = {
    connecting:    ['connecting', '⏳ Conectando...'],
    qr:            ['qr',         '📷 Escaneie o QR'],
    authenticated: ['connecting', '🔐 Autenticado'],
    ready:         ['ready',      `✅ ${number || 'Conectado'}`],
    auth_failure:  ['error',      '❌ Falha'],
    disconnected:  ['error',      '⚠️ Desconectado'],
  };

  const [cls, label] = map[status] || ['', status];
  badge.classList.add(cls);
  text.textContent = label;

  if (status === 'ready') {
    $('btn-connect').textContent  = '✅ Conectado';
    $('btn-connect').disabled     = true;
    $('btn-toggle-prod').disabled = false;
    $('btn-run-now').disabled     = false;
    $('btn-run-test').disabled    = false;
    $('qr-container').innerHTML   = '<div style="font-size:60px;padding:20px">✅</div>';
    $('qr-hint').textContent      = `Conectado: ${number || ''}`;
  }

  if (status === 'disconnected' || status === 'auth_failure') {
    $('btn-connect').disabled     = false;
    $('btn-connect').textContent  = '📱 Reconectar';
    $('btn-toggle-prod').disabled = true;
    $('btn-run-now').disabled     = true;
    $('btn-run-test').disabled    = true;
    if (prodRunning) {
      prodRunning = false;
      $('btn-toggle-prod').className   = 'btn btn-green';
      $('btn-toggle-prod').textContent = '🟢 Ligar Produção';
    }
  }
});

// ─── QR Code ─────────────────────────────────────────────────────────────────
window.api.onQrCode(({ dataUrl }) => {
  $('qr-container').innerHTML = `<img src="${dataUrl}" alt="QR Code">`;
  $('qr-hint').textContent    = 'WhatsApp → Aparelhos conectados → Conectar';
});

// ─── Log ─────────────────────────────────────────────────────────────────────
function addLog(level, msg) {
  const output = $('log-output');
  const line   = document.createElement('div');
  line.className = `log-line log-${level}`;

  const time = document.createElement('span');
  time.className   = 'log-time';
  time.textContent = new Date().toLocaleTimeString('pt-BR');

  const text = document.createElement('span');
  text.className   = 'log-msg';
  text.textContent = msg; // textContent — sem risco de XSS

  line.append(time, text);
  output.appendChild(line);
  output.scrollTop = output.scrollHeight;
  while (output.children.length > 500) output.removeChild(output.firstChild);

  if (level === 'error') { statErrors++; $('stat-errors').textContent = statErrors; }
}

window.api.onLog(({ level, msg }) => addLog(level, msg));

// ─── Mensagens enviadas ───────────────────────────────────────────────────────
// BUG-B CORRIGIDO: sem innerHTML com dados externos — usa criacao segura de DOM
window.api.onMsgSent(({ nome, tipo, hora, data }) => {
  statSent++;
  $('stat-sent').textContent = statSent;

  const icons  = {
    'lembrete':          '⏰',
    'aniversario':       '🎂',
    'confirmacao_sim':   '✅',
    'confirmacao_nao':   '↩️',
    'confirmacao_site':  '✅',
  };
  const labels = {
    'lembrete':          `Lembrete${hora ? ' — ' + hora : ''}`,
    'aniversario':       'Parabéns de aniversário',
    'confirmacao_sim':   'Confirmou presença',
    'confirmacao_nao':   'Solicitou remarcação',
    'confirmacao_site':  'Confirmação de agendamento (site)',
  };

  if (tipo === 'aniversario')     { statBirthday++; $('stat-birthday').textContent = statBirthday; }
  if (tipo === 'confirmacao_sim') { statConfirm++;  $('stat-confirm').textContent  = statConfirm;  }

  const list = $('msgs-list');
  list.querySelector('p')?.remove();

  // BUG-B CORRIGIDO: criacao por DOM API em vez de innerHTML
  const card    = document.createElement('div');
  card.className = 'msg-card';

  const icon     = document.createElement('div');
  icon.className = 'msg-icon';
  icon.textContent = icons[tipo] || '✉️';

  const body     = document.createElement('div');
  body.className = 'msg-body';

  const nomeEl   = document.createElement('div');
  nomeEl.className   = 'msg-nome';
  nomeEl.textContent = nome; // seguro: textContent

  const tipoEl   = document.createElement('div');
  tipoEl.className   = 'msg-tipo';
  tipoEl.textContent = `${labels[tipo] || tipo}${data ? ' · ' + data : ''}`;

  body.append(nomeEl, tipoEl);

  const timeEl   = document.createElement('div');
  timeEl.className   = 'msg-time';
  timeEl.textContent = new Date().toLocaleTimeString('pt-BR');

  card.append(icon, body, timeEl);
  list.insertBefore(card, list.firstChild);
  while (list.children.length > 100) list.removeChild(list.lastChild);
});

// ─── Ultima verificacao (MELHORIA-7) ─────────────────────────────────────────
window.api.onLastCheck(({ time, tab }) => {
  $('last-check').textContent = time;
});

// ─── Auto-update ─────────────────────────────────────────────────────────────
window.api.onUpdateStatus(({ type, version, percent, bytesPerSecond, message }) => {
  const banner = $('update-banner');
  const msg    = $('update-msg');

  const msgs = {
    checking:         'Verificando atualizações...',
    available:        `Nova versão v${version} encontrada. Baixando...`,
    downloading:      `Baixando atualização... ${percent}%${bytesPerSecond ? ' · ' + bytesPerSecond + ' KB/s' : ''}`,
    downloaded:       `v${version} pronta — reiniciando em 3s...`,
    'up-to-date':     null,
    'download-timeout': 'Timeout no download — será tentado novamente em 4h.',
    error:            `Erro na atualização: ${message || 'verifique os logs.'}`,
  };

  if (msgs[type] !== undefined && msgs[type] !== null) {
    banner.style.display    = 'flex';
    banner.style.background = (type === 'error' || type === 'download-timeout')
      ? 'var(--red)' : 'var(--blue)';
    msg.textContent = msgs[type];

    // Esconde o banner de erro após 10s
    if (type === 'error' || type === 'download-timeout' || type === 'up-to-date') {
      setTimeout(() => banner.style.display = 'none', 10_000);
    }
  } else {
    banner.style.display = 'none';
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────
(async () => {
  addLog('info', 'Aplicacao iniciada.');
  const cfg = await window.api.getConfig();
  if (!cfg.googleSheetId || !cfg.credentialsPath) {
    addLog('warn', 'Configure a planilha na aba Configuracoes antes de conectar.');
    document.querySelector('[data-tab="config"]').click();
  } else {
    addLog('info', `Planilha: ${cfg.googleSheetId.slice(0, 20)}...`);
    addLog('info', 'Configuracao OK. Conecte o WhatsApp para comecar.');
  }
})();