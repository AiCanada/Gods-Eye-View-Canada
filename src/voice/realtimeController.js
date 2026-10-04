import { RealtimeConnection } from './realtimeConnection.js';
import { RealtimeTurns } from './realtimeTurns.js';
import { RealtimeViewport } from './realtimeViewport.js';
import { RealtimeDiagnostics } from './realtimeDiagnostics.js';
import { RealtimeRadio } from './realtimeRadio.js';
import { RealtimeFacade } from './realtimeFacade.js';
import { RealtimeCost } from './realtimeCost.js';
import { RealtimeInput } from './realtimeInput.js';

import {
  shouldPauseRadioForVoice,
  shouldStopVoiceAfterRadioTool,
  startPreparedRadioAfterPlaybackReady,
} from './realtimeProtocol.js';
import {
  nextVoiceProvider,
  readStoredVoiceProvider,
  startProviderVoice,
  voiceProviderFullName,
  writeStoredVoiceProvider,
} from './gevVoiceProviders.js';
import { postDebugLog } from './realtimeDiagnostics.js';

export {
  readStoredVoiceTier,
  writeStoredVoiceTier,
  readStoredVoiceLimits,
  writeStoredVoiceLimits,
} from './realtimePreferences.js';
export {
  shouldPauseRadioForVoice,
  shouldStopVoiceAfterRadioTool,
  startPreparedRadioAfterPlaybackReady,
  silenceRadioForVoice,
} from './realtimeProtocol.js';
export {
  computeDownscale,
  estimateDataUrlBytes,
  renderFreshCesiumFrame,
  isBenignViewportDeleteError,
} from './realtimeViewport.js';
export {
  PUSH_TO_TALK_HOLD_DELAY_MS,
  isPushToTalkKey,
  isPushToTalkSurface,
  isInteractiveSpaceTarget,
  isEditingSpaceTarget,
  shouldHandlePushToTalkKeyDown,
  shouldIgnoreVoiceButtonClick,
  selectVoiceVisualizerSignal,
  resolveVoiceVisualizerSpeaker,
  resolveVoiceControlHint,
  gateVoiceVisualizerLevel,
} from './realtimeInputPolicy.js';

import { createRealtimeBackend } from './realtimeBackend.js';

const STATUS = {
  idle: 'OFF',
  connecting: 'CONNECTING',
  listening: 'LISTENING',
  executing: 'EXECUTING',
  error: 'ERROR',
};

/** Compose voice state owners and coordinate ordered session startup/teardown. */
export class GevRealtimeController extends RealtimeFacade {
  constructor({
    runner,
    ui,
    radioLayer = null,
    dataManager = null,
    backend = createRealtimeBackend(),
    signal,
    debugSink = postDebugLog,
    actionExecutor,
    onSessionEvent,
  }) {
    super();
    this.actionExecutor = actionExecutor;
    this.onSessionEvent = onSessionEvent;
    this.backend = backend;
    this.lifetimeSignal = signal;

    this.lifetimeAbort = () => this.stop({ removeUi: true });
    signal?.addEventListener('abort', this.lifetimeAbort, { once: true });
    this.runner = runner;
    this.ui = ui;
    this.radioLayer = radioLayer;
    this.dataManager = dataManager;
    this._viewport = new RealtimeViewport({
      readChannel: () => this.dc,

      operations: {
        sendRealtimeEvent: (...args) => this.sendRealtimeEvent(...args),
      },
    });
    this._diagnostics = new RealtimeDiagnostics({
      readStatus: () => this.status,
      readChannel: () => this.dc,
      readPeer: () => this.pc,
      readCostTracker: () => this.costTracker,
      debugSink,
      operations: {
        setStatus: (...args) => this.setStatus(...args),
      },
    });
    this._radio = new RealtimeRadio({
      readRadioLayer: () => this.radioLayer,
      readDataManager: () => this.dataManager,
      readChannel: () => this.dc,
      readUserTurnPending: () => this.userTurnPending,
      readSessionId: () => this.sessionId,

      operations: {
        abortTools: () => this._turns.abortTools(),
        isActive: (...args) => this.isActive(...args),
        stop: (...args) => this.stop(...args),
        setStatus: (...args) => this.setStatus(...args),
        queueResponseCreate: (...args) => this.queueResponseCreate(...args),
        debugLog: (...args) => this.debugLog(...args),
      },
    });
    this._cost = new RealtimeCost({
      readUi: () => this.ui,
      readStatus: () => this.status,
      operations: {
        isActive: (...args) => this.isActive(...args),
        isVoiceSessionSettled: (...args) => this.isVoiceSessionSettled(...args),
        setStatus: (...args) => this.setStatus(...args),
        debugLog: (...args) => this.debugLog(...args),
        stop: (...args) => this.stop(...args),
      },
    });
    // Fork: a spoken session on Claude, Custom LLM, OpenRouter, Grok or
    // NVIDIA (src/voice/gevVoiceProviders.js). OpenAI stays on WebRTC.
    this.voiceTransport = null;
    this._input = new RealtimeInput({
      readUi: () => this.ui,
      readStream: () => this.stream,
      readStatus: () => this.status,
      readVoiceTransport: () => this.voiceTransport,
      operations: {
        isActive: (...args) => this.isActive(...args),
        setStatus: (...args) => this.setStatus(...args),
        start: (...args) => this.start(...args),
        pauseRadioForVoice: (...args) => this.pauseRadioForVoice(...args),
      },
    });

    this.buttonHandler = null;
    this.tierHandler = null;
    this.providerHandler = null;
    this.annotationEventUnsubscribe = null;

    this.status = 'idle';

    this._turns = new RealtimeTurns({
      readActionExecutor: () => this.actionExecutor,
      readRunner: () => this.runner,
      readChannel: () => this.dc,
      readDataManager: () => this.dataManager,
      readRadioLayer: () => this.radioLayer,
      radio: this._radio,
      viewport: this._viewport,
      operations: {
        cancelRadioHandoff: (...args) => this.cancelRadioHandoff(...args),
        connectionDiagnostics: (...args) => this.connectionDiagnostics(...args),
        debugLog: (...args) => this.debugLog(...args),
        emitSessionEvent: (...args) => this.emitSessionEvent(...args),
        isRadioHandoffReserved: (...args) =>
          this.isRadioHandoffReserved(...args),
        isSessionEnding: (...args) => this.isSessionEnding(...args),
        pauseRadioForVoice: (...args) => this.pauseRadioForVoice(...args),
        recordUsage: (...args) => this.recordUsage(...args),
        reportError: (...args) => this.reportError(...args),
        reserveRadioToolHandoff: (...args) =>
          this.reserveRadioToolHandoff(...args),
        sendRealtimeEvent: (...args) => this.sendRealtimeEvent(...args),
        sendVisualContextIfUseful: (...args) =>
          this.sendVisualContextIfUseful(...args),
        setStatus: (...args) => this.setStatus(...args),
        setVoiceSpeaker: (...args) => this.setVoiceSpeaker(...args),
        settleRadioToolHandoffReservation: (...args) =>
          this.settleRadioToolHandoffReservation(...args),
        startPendingRadioHandoff: (...args) =>
          this.startPendingRadioHandoff(...args),
        stop: (...args) => this.stop(...args),
      },
    });
    this._connection = new RealtimeConnection({
      readLifetimeSignal: () => this.lifetimeSignal,
      readBackend: () => this.backend,
      readStatus: () => this.status,
      input: this._input,
      cost: this._cost,
      operations: {
        isActive: (...args) => this.isActive(...args),
        pauseRadioForVoice: (...args) => this.pauseRadioForVoice(...args),
        stop: (...args) => this.stop(...args),
        syncCostUi: (...args) => this.syncCostUi(...args),
        setStatus: (...args) => this.setStatus(...args),
        debugLog: (...args) => this.debugLog(...args),
        connectionDiagnostics: (...args) => this.connectionDiagnostics(...args),
        setMicrophoneEnabled: (...args) => this.setMicrophoneEnabled(...args),
        startVoiceVisualizer: (...args) => this.startVoiceVisualizer(...args),
        startAssistantVoiceVisualizer: (...args) =>
          this.startAssistantVoiceVisualizer(...args),
        fatalError: (...args) => this.fatalError(...args),
        reportError: (...args) => this.reportError(...args),
        handleRealtimeEvent: (...args) => this.handleRealtimeEvent(...args),
      },
    });
    this._radio.observe();
    this.debugLog('controller.created', { status: this.status });
  }

  isActive() {
    return this.status !== 'idle' && this.status !== 'error';
  }

  /** OpenAI runs the WebRTC session; any other stored provider its own. */
  start(settings = {}) {
    if (readStoredVoiceProvider() !== 'openai')
      return this.startProviderSession(settings);
    return this._connection.start(settings);
  }

  /**
   * Spoken session for Claude, Custom LLM, OpenRouter, Grok, or NVIDIA.
   * OpenAI stays on the WebRTC path. Tools still run in this browser.
   */
  async startProviderSession({ pushToTalk = false } = {}) {
    if (this.isActive() || this.lifetimeSignal?.aborted) return;
    this.pauseRadioForVoice();
    const pushToTalkKeyHeld = pushToTalk && this.pushToTalkKeyHeld;
    const spaceKeyHeld = this.spaceKeyHeld;
    this.stop({ preserveStatus: true });
    this.pushToTalkMode = pushToTalk;
    this.pushToTalkKeyHeld = pushToTalkKeyHeld;
    this.spaceKeyHeld = spaceKeyHeld;
    const epoch = ++this.startEpoch;
    const provider = readStoredVoiceProvider();
    const fullName = voiceProviderFullName(provider);
    this.costCapStopped = false;
    this.setStatus('connecting', fullName);
    const providerToolAbort = new AbortController();
    this.activeToolAbortControllers.add(providerToolAbort);
    const isCurrent = () => epoch === this.startEpoch;
    const runTool = this.actionExecutor || this.runner;
    try {
      const transport = await startProviderVoice({
        provider,
        pushToTalk,
        initiallyHeld: this.pushToTalkKeyHeld,
        isCurrent,
        getUserMedia: (constraints) => {
          const media = globalThis.navigator?.mediaDevices;
          if (typeof media?.getUserMedia !== 'function') {
            throw new Error('Microphone support is unavailable.');
          }
          return media.getUserMedia(constraints);
        },
        WebSocket: globalThis.WebSocket,
        AudioContext: globalThis.AudioContext || globalThis.webkitAudioContext,
        SpeechRecognition:
          globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition,
        speechSynthesis: globalThis.speechSynthesis,
        MediaRecorder: globalThis.MediaRecorder,
        fetch: globalThis.fetch.bind(globalThis),
        setStream: (stream) => {
          if (!isCurrent()) return;
          this.stream = stream;
          this.startVoiceVisualizer(stream);
        },
        setStatus: (status, detail) => {
          if (isCurrent()) this.setStatus(status, detail);
        },
        setSpeaker: (speaker) => {
          if (isCurrent()) this.setVoiceSpeaker(speaker);
        },
        fail: (error) => {
          if (!isCurrent()) return;
          this.stop({ preserveStatus: true });
          this.reportError(fullName, error);
        },
        runner: (name, args) =>
          runTool(name, args, {
            signal: providerToolAbort.signal,
            isCurrent: () => epoch === this.startEpoch && !this.userTurnPending,
          }),
        finishRadio: (result) => this.finishProviderRadio(result),
        stopForRadio: () => {
          if (isCurrent()) this.stop();
        },
        classifyRadio: (result) => {
          if (
            shouldStopVoiceAfterRadioTool(result) &&
            !result?.radioPlaybackRequested &&
            !result?.radioPlaybackSuppressed
          )
            return 'stop';
          if (result?.radioPlaybackRequested) return 'playback';
          return '';
        },
      });
      if (!isCurrent()) {
        transport?.stop?.();
        return;
      }
      if (!transport) return;
      this.voiceTransport = transport;
      this.setMicrophoneEnabled(!this.pushToTalkMode || this.pushToTalkKeyHeld);
      this.setStatus(
        'listening',
        pushToTalk ? 'Hold Space to talk' : 'Ask or command',
      );
    } catch (error) {
      if (!isCurrent()) return;
      this.stop({ preserveStatus: true });
      this.reportError(fullName, error);
    }
  }

  /** Hand a prepared station to Radio after a non-OpenAI voice has spoken. */
  async finishProviderRadio(result) {
    if (
      !result?.ok ||
      !result.radioPlaybackRequested ||
      !this.voiceTransport ||
      !this.isActive() ||
      this.isRadioHandoffReserved() ||
      this.radioHandoffInFlight
    )
      return;
    const handoffEpoch = ++this.radioHandoffEpoch;
    const handoffAttemptId = `voice-radio-${this.sessionId}-${handoffEpoch}`;
    this.radioHandoffInFlight = true;
    this.radioHandoffAttemptId = handoffAttemptId;
    this.radioHandoffInFlightResult = result;
    this.radioLayer?.setVoiceDucked?.(true);
    const radioHandoff = await startPreparedRadioAfterPlaybackReady(result, {
      prepareRadio: () =>
        this.radioLayer?.playForVoice?.({ attemptId: handoffAttemptId }),
      stopVoice: () => this.stop({ preserveRadioPlayback: true }),
      cancelRadio: () =>
        this.radioLayer?.stopPlayback?.({
          origin: 'voice-cleanup',
          attemptId: handoffAttemptId,
        }),
      isCurrent: () =>
        this.voiceTransport != null &&
        this.isActive() &&
        this.radioHandoffInFlight &&
        !this.isRadioHandoffReserved() &&
        handoffEpoch === this.radioHandoffEpoch &&
        !this.userTurnPending,
    });
    const stillCurrent = handoffEpoch === this.radioHandoffEpoch;
    if (this.radioHandoffAttemptId === handoffAttemptId) {
      this.radioHandoffInFlight = false;
      this.radioHandoffAttemptId = null;
      if (this.radioHandoffInFlightResult === result) {
        this.radioHandoffInFlightResult = null;
      }
    }
    this.debugLog('tool.radio_handoff', { result: radioHandoff.result });
    if (radioHandoff.result?.ok || radioHandoff.cancelled || !stillCurrent)
      return;
    if (this.voiceTransport && this.isActive() && !this.userTurnPending) {
      this.setStatus('listening', 'Radio did not start');
    }
  }

  /** Step to the next voice provider; a live session stops so the next uses it. */
  cycleVoiceProvider() {
    const next = writeStoredVoiceProvider(
      nextVoiceProvider(readStoredVoiceProvider()),
    );
    if (this.isActive()) this.stop();
    this.syncCostUi();
    return next;
  }

  // Fatal error path: tear the session down (stop tracks, close pc/dc, kill the
  // mic) BEFORE flipping the UI to ERROR, so we never sit in an ERROR state with
  // a live hot mic behind it (H8). stop() itself bumps the epoch and clears the
  // grace timer; preserveStatus lets reportError own the final 'error' status.
  fatalError(source, error = null, extra = {}) {
    this.stop({ preserveStatus: true });
    return this.reportError(source, error, extra);
  }

  stop(options = {}) {
    const {
      removeUi = false,
      preserveStatus = false,
      preserveRadioPlayback = false,
    } = options;
    // Bump the epoch so any start() awaiting a token/getUserMedia/SDP bails and
    // releases its own resources instead of promoting them onto a stopped
    // controller (H7).
    this._connection.invalidate();
    const providerTransport = this.voiceTransport;
    this.voiceTransport = null;
    if (providerTransport) {
      try {
        providerTransport.stop();
      } catch {
        /* already stopped */
      }
    }
    if (removeUi)
      this.lifetimeSignal?.removeEventListener('abort', this.lifetimeAbort);
    this.cancelPushToTalkHold();
    this._radio.invalidateHandoff();
    this._turns.abortTools();
    this._radio.stopHandoff({ preserveRadioPlayback });
    this.clearDisconnectGrace();
    // Guard against the dc.close() below re-entering our own error handlers while
    // we're intentionally tearing down (the close/error listeners bail on this
    // flag) — H8.
    this._connection.beginTeardown();
    this.debugLog('session.stop', {
      removeUi,
      preserveStatus,
      status: this.status,
      connection: this.connectionDiagnostics(),
    });
    if (this.dc && this.responseActive) this.costTracker.markIncomplete();
    this._connection.closeTransport();
    this.stopVoiceVisualizer();
    this._connection.releaseMedia();
    this._turns.reset();
    this._radio.clearPendingPlayback();
    this._viewport.reset();
    this._input.resetSession();
    if (removeUi && this.ui?.button && this.buttonHandler) {
      this.ui.button.removeEventListener('click', this.buttonHandler);
      this.buttonHandler = null;
    }
    if (removeUi && this.ui?.tierButton && this.tierHandler) {
      this.ui.tierButton.removeEventListener('click', this.tierHandler);
      this.tierHandler = null;
    }
    if (removeUi && this.ui?.providerButton && this.providerHandler) {
      this.ui.providerButton.removeEventListener('click', this.providerHandler);
      this.providerHandler = null;
    }
    if (removeUi) this._input.detachBindings();
    if (removeUi && this.annotationEventUnsubscribe) {
      // Full teardown (re-init path): stop listening to the long-lived annotation
      // engine so a replaced controller can't keep receiving outline events.
      this.annotationEventUnsubscribe();
      this.annotationEventUnsubscribe = null;
    }
    if (removeUi) this._radio.detachObservers();
    if (removeUi && this.ui?.root) {
      this.ui.root.remove();
    }
    if (!preserveStatus && !removeUi) {
      this.setStatus('idle', 'Voice off');
    }
    this.setRadioVoiceDucking(false);
    if (removeUi) this.emitSessionEvent({ type: 'disposed' });
  }

  emitSessionEvent(event) {
    try {
      this.onSessionEvent?.(event);
    } catch {
      /* Observers cannot interrupt voice. */
    }
  }

  setStatus(status, detail) {
    this.status = status;
    this.emitSessionEvent({ type: 'state', state: status, detail });
    this.ui.root.dataset.status = status;
    if (status === 'error') this.ui.root.classList.remove('error-dismissed');
    this.updateVoiceButtonLabel();
    this.ui.status.textContent = STATUS[status] || STATUS.idle;
    const resolvedDetail =
      status === 'listening' && this.pushToTalkMode
        ? this.pushToTalkKeyHeld
          ? 'Release Space to send'
          : 'Hold Space to talk'
        : detail;
    const primaryDetail =
      status === 'error'
        ? 'VOICE UNAVAILABLE'
        : resolvedDetail ||
          (status === 'idle' ? 'VOICE STANDBY' : 'VOICE ACTIVE');
    this.ui.detail.textContent = primaryDetail;
    this.ui.detail.title = primaryDetail;
    if (this.ui.errorDetail) {
      this.ui.errorDetail.textContent =
        status === 'error'
          ? resolvedDetail || 'Voice session could not be started.'
          : '';
    }
    if (status === 'idle' || status === 'connecting' || status === 'error') {
      this.setVoiceSpeaker('idle');
    }
    if (
      shouldPauseRadioForVoice({
        status,
        pushToTalkKeyHeld: this.pushToTalkKeyHeld,
      })
    ) {
      this.pauseRadioForVoice();
    }
  }

  /* ---------------- voice cost control ---------------- */

  /**
   * Is this session terminating (spend cap reached)? Latched — never clears
   * until the next start().
   *
   * IN-FLIGHT TOOLS RUN TO COMPLETION, AND ARE NOT ROLLED BACK. A tool already
   * executing when the cap trips may finish its map mutation (a camera flight,
   * a layer toggle, an annotation). That is deliberate: unwinding a partially
   * applied map change has no safe general implementation — a half-reverted
   * camera/layer/annotation state is worse than a completed one, and the tool
   * abort signal is advisory (most actions do not check it). What the latch DOES
   * guarantee is that no NEW tool is dispatched once the cap has tripped.
   */
  isSessionEnding() {
    return this.costCapStopped === true;
  }

  /**
   * Is the voice session FULLY settled — no live session and no transport left?
   *
   * Replacing the cost tracker is only legal here. `!isActive()` alone is not
   * enough: the 'error' status reports inactive while the data/peer connection
   * may still be open and delivering a late `response.done`. Rebuilding on that
   * signal would send late usage to a fresh preview tracker instead of the one
   * that owns the session's spend.
   */
  isVoiceSessionSettled() {
    return !this.isActive() && !this.dc && !this.pc && !this.voiceTransport;
  }
}
