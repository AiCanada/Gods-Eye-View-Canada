// Options page for the GEV Arlo Feed Relay. It talks only to this extension's
// service worker and renders everything with textContent.
(function startRelayOptions() {
  'use strict';

  const POLL_MS = 3000;
  const POLL_LIMIT_MS = 120000;
  const STATUS_MS = 5000;
  const PAIR_STATE_MS = 30000;
  const NOT_RECOGNISED_TEXT = 'Not paired — Gods Eye View no longer recognises this pairing. Press PAIR WITH GODS EYE VIEW to pair again.';
  const STATE_LABELS = {
    feed: 'reading the feed',
    'signed-out': 'Arlo signed out',
    'no-cards': 'no clips loaded',
    'layout-unknown': 'feed layout not recognised',
  };

  const byId = (id) => document.getElementById(id);
  const view = {
    extensionId: byId('extension-id'),
    pairState: byId('pair-state'),
    pairButton: byId('pair-button'),
    forgetButton: byId('forget-button'),
    pairRequest: byId('pair-request'),
    pairCode: byId('pair-code'),
    pairExtensionId: byId('pair-extension-id'),
    pairProgress: byId('pair-progress'),
    error: byId('pair-error'),
    feedLine: byId('feed-line'),
    recentList: byId('recent-list'),
    recentEmpty: byId('recent-empty'),
  };
  let pollTimer = 0;
  let pollUntil = 0;
  let pairing = false;

  function send(message) {
    const unanswered = { ok: false, error: 'The relay did not answer. Reload the extension and try again.' };
    try {
      return chrome.runtime.sendMessage(message).then(
        (reply) => (reply && typeof reply === 'object' ? reply : unanswered),
        () => unanswered,
      );
    } catch (_) {
      return Promise.resolve(unanswered);
    }
  }

  function showError(text) {
    view.error.textContent = text || '';
    view.error.hidden = !text;
  }

  function timeLabel(at) {
    const value = Number(at);
    return Number.isFinite(value) && value > 0 ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  }

  function describePairing(reply) {
    if (reply.paired === true) {
      const site = typeof reply.siteName === 'string' && reply.siteName ? reply.siteName : 'your Arlo site';
      const cameras = Array.isArray(reply.cameras) && reply.cameras.length ? ` (cameras: ${reply.cameras.join(', ')})` : '';
      return `Paired with “${site}” in Gods Eye View${cameras}`;
    }
    if (reply.reachable === false) return `${reply.error || 'Gods Eye View is not reachable'} — start the app`;
    if (reply.local === 'pending') return 'Waiting for approval in Gods Eye View';
    if (reply.local === 'paired') return NOT_RECOGNISED_TEXT;
    if (typeof reply.error === 'string' && reply.error) return reply.error;
    return 'Not paired';
  }

  async function refreshPairing() {
    const reply = await send({ type: 'pair-status' });
    view.pairState.textContent = describePairing(reply);
    view.forgetButton.disabled = !(reply.local === 'paired' || reply.local === 'pending');
    return reply;
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, POLL_MS);
  }

  async function poll() {
    const reply = await refreshPairing();
    pollTimer = 0;
    if (reply.approved === true || (reply.paired === true && reply.local === 'paired' && !reply.pendingExpired)) {
      view.pairProgress.textContent = 'Approved — the relay is paired. Keep your my.arlo.com feed open.';
      return;
    }
    if (reply.local === 'pending' || reply.reachable === false) {
      if (Date.now() < pollUntil) {
        schedulePoll();
        return;
      }
      view.pairProgress.textContent = 'No approval within 2 minutes. Press PAIR WITH GODS EYE VIEW to get a new code.';
      return;
    }
    view.pairProgress.textContent = 'The pairing request expired or was replaced. Press PAIR WITH GODS EYE VIEW to get a new code.';
  }

  async function pair() {
    if (pairing) return;
    pairing = true;
    view.pairButton.disabled = true;
    showError('');
    const reply = await send({ type: 'pair' });
    view.pairButton.disabled = false;
    pairing = false;
    if (reply.ok !== true) {
      showError(reply.error || 'The pairing request failed.');
      return;
    }
    view.pairCode.textContent = String(reply.code || '');
    view.pairExtensionId.textContent = String(reply.extensionId || chrome.runtime.id);
    view.pairProgress.textContent = 'Waiting for approval in Gods Eye View…';
    view.pairRequest.hidden = false;
    view.forgetButton.disabled = false;
    const seconds = Number(reply.expiresInSeconds);
    pollUntil = Date.now() + (Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, POLL_LIMIT_MS) : POLL_LIMIT_MS);
    schedulePoll();
  }

  async function forget() {
    const confirmed = window.confirm('Forget this pairing? The relay stops sending pictures until you pair again. Also press UNPAIR in Gods Eye View → POWER UP → HOME SECURITY.');
    if (!confirmed) return;
    clearTimeout(pollTimer);
    pollTimer = 0;
    const reply = await send({ type: 'forget' });
    showError(reply.ok === true ? '' : reply.error || 'Could not forget the pairing.');
    view.pairRequest.hidden = true;
    await refreshPairing();
    await refreshStatus();
  }

  async function refreshStatus() {
    const reply = await send({ type: 'status' });
    // A feed tab found that GEV no longer takes this pairing (UNPAIR in POWER UP, say): say so now.
    if (reply.notPaired === true && !pollTimer && !pairing) {
      view.pairState.textContent = NOT_RECOGNISED_TEXT;
      view.forgetButton.disabled = false;
    }
    const entries = Array.isArray(reply.recent) ? reply.recent : [];
    const rows = entries.map((entry) => {
      const row = document.createElement('li');
      const time = document.createElement('span');
      time.className = 'recent-time';
      time.textContent = timeLabel(entry && entry.at);
      const camera = document.createElement('span');
      camera.className = 'recent-camera';
      camera.textContent = String((entry && entry.camera) || '');
      const outcome = document.createElement('span');
      outcome.className = entry && entry.outcome === 'sent' ? 'recent-outcome is-ok' : 'recent-outcome';
      outcome.textContent = String((entry && entry.outcome) || '');
      row.append(time, camera, outcome);
      return row;
    });
    view.recentList.replaceChildren(...rows);
    view.recentEmpty.hidden = rows.length > 0;
    const beat = reply.heartbeat && typeof reply.heartbeat === 'object' ? reply.heartbeat : null;
    if (beat) {
      const state = typeof beat.state === 'string' && Object.hasOwn(STATE_LABELS, beat.state) ? STATE_LABELS[beat.state] : 'unknown state';
      view.feedLine.textContent = `Feed tab report at ${timeLabel(beat.at)}: ${state} · GEV: ${beat.outcome || 'unknown'}`;
    } else {
      view.feedLine.textContent =
        'No my.arlo.com feed report since the relay last woke up (one arrives every 2 minutes). If none comes, reload your my.arlo.com feed tab: a tab opened before the extension was installed or updated is not read.';
    }
  }

  view.extensionId.textContent = chrome.runtime.id;
  view.pairButton.addEventListener('click', () => pair());
  view.forgetButton.addEventListener('click', () => forget());
  refreshPairing();
  refreshStatus();
  setInterval(refreshStatus, STATUS_MS);
  setInterval(() => {
    if (!pollTimer && !pairing) refreshPairing();
  }, PAIR_STATE_MS);
})();
