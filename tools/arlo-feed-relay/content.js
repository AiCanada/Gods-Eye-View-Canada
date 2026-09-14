// GEV Arlo Feed Relay content script (isolated world, top frame of my.arlo.com).
// It reads what the feed page already shows (camera name, clip label and the
// newest thumbnail address per camera) and hands it to this extension's service
// worker, which does all network work. It never clicks, scrolls, reloads or
// navigates the page, never reads storage or cookies and never touches the
// page's own JavaScript.
//
// A thumbnail is downloaded from Arlo only when GEV will take it: the heartbeat
// goes first, and its answer says whether GEV accepts this relay, which of the
// cameras seen here still need a picture and which names match no camera. A
// refused thumbnail is never fetched again; other failures back off.
(function startGevArloFeedRelay() {
  'use strict';

  const relay = globalThis.GevArloRelay;
  if (!relay || typeof chrome !== 'object' || !chrome || !chrome.runtime) return;

  const DEBOUNCE_MS = 1500;
  const MAX_DEBOUNCE_WAIT_MS = 10000;
  const HEARTBEAT_MS = 120000;
  // While GEV does not take the relay (not paired or approved yet, not running),
  // only a heartbeat goes out, every 15 seconds: no Arlo traffic at all.
  const NOT_READY_CHECK_MS = 15000;
  // A feed page still drawing is not reported as an unknown layout this early.
  const STARTUP_GRACE_MS = 20000;
  const FAILED_RETRY_MS = 30000;
  const MAX_BACKOFF_MS = 10 * 60 * 1000;
  const SEEN_LIMIT = 20;

  // normalized camera name -> { key, outcome: 'sent' | 'refused' | 'failed', failures, retryAt }
  const sends = new Map();
  const inflight = new Map(); // normalized camera name -> urlKey being relayed
  const startedAt = Date.now();
  let unknownCameras = new Set(); // normalized names GEV says match no camera
  let ready = false; // GEV accepted the last heartbeat
  let heartbeatSignature = '';
  let heartbeatAt = 0;
  let epoch = null;
  let observer = null;
  let debounceTimer = 0;
  let debounceStartedAt = 0;
  let tickTimer = 0;
  let tickDelay = 0;
  let retryTimer = 0;
  let stopped = false;

  function extensionAlive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (observer) observer.disconnect();
    observer = null;
    clearTimeout(debounceTimer);
    clearTimeout(tickTimer);
    clearTimeout(retryTimer);
    window.removeEventListener('hashchange', schedule);
  }

  function failed(error) {
    const message = error && typeof error.message === 'string' ? error.message : '';
    if (!extensionAlive() || /context invalidated/i.test(message)) stop();
    return null;
  }

  // A reply carries an opaque pairing epoch; a new epoch (first pairing or
  // re-pairing) means GEV has none of this tab's pictures yet.
  function noteReply(reply) {
    if (!reply || typeof reply !== 'object') return null;
    const nextEpoch = typeof reply.epoch === 'string' ? reply.epoch : '';
    if (epoch !== null && nextEpoch !== epoch) {
      sends.clear();
      unknownCameras = new Set();
      heartbeatSignature = '';
      schedule();
    }
    epoch = nextEpoch;
    return reply;
  }

  function request(message) {
    if (stopped) return Promise.resolve(null);
    if (!extensionAlive()) {
      stop();
      return Promise.resolve(null);
    }
    let pending;
    try {
      pending = chrome.runtime.sendMessage(message);
    } catch (error) {
      return Promise.resolve(failed(error));
    }
    return Promise.resolve(pending).then(noteReply, failed);
  }

  function schedule() {
    if (stopped) return;
    const now = Date.now();
    if (!debounceTimer) debounceStartedAt = now;
    clearTimeout(debounceTimer);
    const wait = Math.max(0, Math.min(DEBOUNCE_MS, debounceStartedAt + MAX_DEBOUNCE_WAIT_MS - now));
    debounceTimer = setTimeout(() => {
      debounceTimer = 0;
      scan(false);
    }, wait);
  }

  function scheduleTick() {
    if (stopped) return;
    const delay = ready ? HEARTBEAT_MS : NOT_READY_CHECK_MS;
    if (tickTimer && delay === tickDelay) return;
    clearTimeout(tickTimer);
    tickDelay = delay;
    tickTimer = setTimeout(() => {
      tickTimer = 0;
      scan(true);
      scheduleTick();
    }, delay);
  }

  function retrySoon(delay) {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = 0;
      scan(false);
    }, delay);
  }

  function readFeed() {
    try {
      const state = relay.detectFeedState(document, location);
      const newest = state === 'feed' ? relay.pickNewestPerCamera(relay.readFeedItems(document)) : new Map();
      return { state, newest };
    } catch (_) {
      return { state: 'layout-unknown', newest: new Map() };
    }
  }

  function namesFrom(list) {
    const names = new Set();
    if (!Array.isArray(list)) return names;
    for (const name of list) {
      const normalized = relay.normalizeCameraName(name);
      if (normalized) names.add(normalized);
    }
    return names;
  }

  function noteHeartbeat(reply) {
    const wasReady = ready;
    ready = Boolean(reply && reply.sent === true);
    if (ready) {
      unknownCameras = namesFrom(reply.unknown);
      // GEV lost these pictures (restart, approval, config change): send them again.
      // A refused thumbnail stays refused and a failed one keeps its backoff.
      for (const camera of namesFrom(reply.missing)) {
        const last = sends.get(camera);
        if (last && last.outcome === 'sent') sends.delete(camera);
      }
    }
    if (ready !== wasReady) scheduleTick();
  }

  function frameDue(camera, key, now) {
    if (!key || inflight.get(camera) === key) return false;
    const last = sends.get(camera);
    if (!last || last.key !== key) return true;
    return last.outcome === 'failed' && now >= last.retryAt;
  }

  function sendFrame(camera, key, item) {
    inflight.set(camera, key);
    request({ type: 'frame', camera: item.name, url: item.src, clip: item.clip }).then((reply) => {
      if (inflight.get(camera) === key) inflight.delete(camera);
      if (stopped) return;
      if (reply && reply.done === true) {
        sends.set(camera, { key, outcome: reply.refused === true ? 'refused' : 'sent', failures: 0, retryAt: 0 });
        return;
      }
      const now = Date.now();
      const previous = sends.get(camera);
      const failures = previous && previous.key === key && previous.outcome === 'failed' ? previous.failures + 1 : 1;
      const hinted = reply && Number.isFinite(reply.retryAfterMs) && reply.retryAfterMs > 0 ? reply.retryAfterMs : 0;
      const delay = Math.min(MAX_BACKOFF_MS, hinted || FAILED_RETRY_MS * 2 ** (failures - 1));
      sends.set(camera, { key, outcome: 'failed', failures, retryAt: now + delay });
      if (reply && reply.gevReady === false) {
        // GEV is gone or no longer knows this relay: only heartbeats until it takes the relay again.
        ready = false;
        scheduleTick();
      } else if (delay < HEARTBEAT_MS) {
        retrySoon(delay);
      }
    });
  }

  function sendFrames(newest) {
    if (stopped || !ready) return;
    const now = Date.now();
    for (const [camera, item] of newest) {
      if (unknownCameras.has(camera)) continue;
      const key = relay.urlKey(item.src);
      if (frameDue(camera, key, now)) sendFrame(camera, key, item);
    }
  }

  function scan(forceHeartbeat) {
    if (stopped) return;
    if (!extensionAlive()) {
      stop();
      return;
    }
    const { state, newest } = readFeed();
    // Another Arlo page in this tab says nothing, so it never contradicts a tab reading the feed.
    if (!relay.isReportablePage(state, location)) return;
    const now = Date.now();
    if (state === 'layout-unknown' && now - startedAt < STARTUP_GRACE_MS) {
      retrySoon(startedAt + STARTUP_GRACE_MS - now);
      return;
    }
    const seen = [];
    for (const item of newest.values()) {
      if (seen.length < SEEN_LIMIT) seen.push(relay.cleanLabel(item.name, relay.CAMERA_NAME_MAX_LENGTH));
    }
    const signature = JSON.stringify([state, seen]);
    if (forceHeartbeat || signature !== heartbeatSignature || now - heartbeatAt >= HEARTBEAT_MS) {
      heartbeatSignature = signature;
      heartbeatAt = now;
      request({ type: 'heartbeat', state, seen }).then((reply) => {
        if (stopped) return;
        noteHeartbeat(reply);
        sendFrames(newest);
      });
      return;
    }
    sendFrames(newest);
  }

  try {
    observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch (_) {
    observer = null;
  }
  window.addEventListener('hashchange', schedule);
  schedule();
  scheduleTick();
})();
