// Framework-less, same spirit as src/options. withGlobalTauri exposes invoke.
const { invoke } = window.__TAURI__.core;

const $ = (id) => document.getElementById(id);
const msg = (text, isError = false) => {
  $('msg').textContent = text;
  $('msg').className = isError ? 'err' : '';
};

const mark = (el, on, offText) => {
  el.textContent = on ? '✓ active' : offText;
};

async function refresh() {
  try {
    const s = await invoke('get_status');
    $('version').textContent = `v${s.version}${s.pro ? ' · Pro' : ''}`;
    const banner = $('lock-banner');
    if (s.status.forceBlocking) {
      banner.textContent = `🔒 Forced blocking active (${s.status.reasons.join(', ')})` +
        (s.status.until ? ` — until ${new Date(s.status.until).toLocaleString()}` : '');
      banner.className = 'locked';
    } else if (s.status.settingsLocked) {
      banner.textContent = `🔒 Settings locked (${s.status.reasons.join(', ')})` +
        (s.status.until ? ` — until ${new Date(s.status.until).toLocaleString()}` : ' — until unlocked');
      banner.className = 'locked';
    } else {
      banner.textContent = 'No lock active';
      banner.className = '';
    }
    mark($('enf-app'), s.enforcement?.appBlocking ?? false, '');
    mark($('enf-watchdog'), s.enforcement?.watchdog ?? false, '');
    $('enf-policy').textContent = (s.enforcement?.policyProtected ?? s.policyEnforce)
      ? '✓ active'
      : 'unavailable until store release';
    if (document.activeElement !== $('apps')) {
      $('apps').value = s.appBlocklist.join('\n');
    }
  } catch (e) {
    msg(String(e), true);
  }
}

$('timer').addEventListener('click', async () => {
  try {
    await invoke('start_timer_lock', { minutes: Number($('minutes').value) || 60 });
    msg('Timer lock started.');
  } catch (e) { msg(String(e), true); }
  refresh();
});

$('frozen').addEventListener('click', async () => {
  try {
    await invoke('start_frozen_turkey', { minutes: Number($('minutes').value) || 60 });
    msg('Frozen Turkey started — blocking is now forced.');
  } catch (e) { msg(String(e), true); }
  refresh();
});

$('save-apps').addEventListener('click', async () => {
  const apps = $('apps').value.split('\n').map((s) => s.trim()).filter(Boolean);
  try {
    await invoke('set_app_blocklist', { apps });
    msg('Blocked apps saved.');
  } catch (e) { msg(String(e), true); }
  refresh();
});

$('install').addEventListener('click', async () => {
  try {
    msg(await invoke('install_integration'));
  } catch (e) { msg(String(e), true); }
});

refresh();
setInterval(refresh, 2000);
