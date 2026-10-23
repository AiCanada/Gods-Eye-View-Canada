import { initFirstRunExperience } from '../firstRunExperience.js';
import { initUltraHelpPanel } from '../ultraHelpPanel.js';
import { initAiWorldPanel } from '../aiWorldPanel.js';
import { initAiWorldOverlay } from '../aiWorldOverlay.js';
import { initDistillPanel } from '../distillPanel.js';
import { initAbundancePanel } from '../abundancePanel.js';
import { initAbundanceOverlay } from '../abundanceOverlay.js';
import { viewCenterPoint } from '../locationClick.js';
import { installPanelCornerResize } from '../ui/panelCornerResize.js';

/** Reveal welcome controls only after restoration and the loading transition. */
export function startApplicationChrome({
  loadingScreen,
  styleManager,
  dataManager,
  signal,
  initializeWelcome = initFirstRunExperience,
  initializeSettings,
  // Fork: the Ultra help box (SEND HELP) lives as long as the shell does. It
  // is a no-op on a page without #ultra-panel.
  initializeHelp = initUltraHelpPanel,
  // Fork: the Artificial Intelligence World Training Sim box (its status
  // poll and the layer list it follows) lives as long as the shell does. It
  // is a no-op on a page without #ai-world-panel.
  initializeAiWorld = initAiWorldPanel,
  // Its predictions on the globe: drawn from the box's choice of domains,
  // removed with the shell.
  initializeAiWorldOverlay = initAiWorldOverlay,
  // Fork: the AI Distillation box (owner request 2026-10-19) lives as long
  // as the shell does. It is a no-op on a page without #distill-panel.
  initializeDistill = initDistillPanel,
  // Fork: the Global Abundance Map box (owner request 2026-10-22) and its
  // colours on the globe live as long as the shell does. Both are no-ops on
  // a page without #abundance-panel.
  initializeAbundance = initAbundancePanel,
  initializeAbundanceOverlay = initAbundanceOverlay,
  // Every dashboard box resizes from its corner on desktop (owner request
  // 2026-10-16); removed with the shell.
  initializePanelResize = installPanelCornerResize,
}) {
  let disposed = false;
  let firstRun;
  let revealTimer;
  let resolveDelay;
  const minimumDelay = new Promise((resolve) => {
    resolveDelay = resolve;
  });
  const delayTimer = setTimeout(resolveDelay, 1000);
  const revealFirstRun = () => {
    if (disposed || signal.aborted || firstRun) return;
    firstRun = initializeWelcome?.({ styleManager, dataManager });
    clearTimeout(revealTimer);
    loadingScreen.removeEventListener('transitionend', revealFirstRun);
  };
  void Promise.all([styleManager.initialRestorePromise, minimumDelay])
    .catch(() => {
      /* Restoration reports its own outcome through the controls. */
    })
    .then(() => {
      if (disposed || signal.aborted) return;
      loadingScreen.classList.add('hidden');
      loadingScreen.addEventListener('transitionend', revealFirstRun, {
        once: true,
      });
      revealTimer = setTimeout(revealFirstRun, 900);
    });
  const keySetup = Promise.resolve(
    signal.aborted ? null : initializeSettings?.({ signal }),
  );
  const ultraHelp = signal.aborted
    ? null
    : initializeHelp?.({ signal, dataManager });
  const aiWorld = signal.aborted
    ? null
    : initializeAiWorld?.({
        signal,
        dataManager,
        // ADD VIEW AS AREA takes the place in the middle of the map.
        viewPoint: () => viewCenterPoint(dataManager?.viewer),
      });
  const aiWorldOverlay = signal.aborted
    ? null
    : initializeAiWorldOverlay?.({ signal, dataManager });
  const distill = signal.aborted ? null : initializeDistill?.({ signal });
  const abundance = signal.aborted ? null : initializeAbundance?.({ signal });
  const abundanceOverlay = signal.aborted
    ? null
    : initializeAbundanceOverlay?.({ signal, dataManager });
  const panelResize = signal.aborted
    ? null
    : initializePanelResize?.({ signal });
  // Own the pending initializer too; it must not reveal a dialog after abort.
  void keySetup.catch(() =>
    console.error('Provider settings initialization failed'),
  );
  return async () => {
    disposed = true;
    clearTimeout(delayTimer);
    clearTimeout(revealTimer);
    resolveDelay();
    loadingScreen.removeEventListener('transitionend', revealFirstRun);
    firstRun?.destroy();
    ultraHelp?.destroy?.();
    aiWorld?.destroy?.();
    aiWorldOverlay?.destroy?.();
    distill?.destroy?.();
    abundance?.destroy?.();
    abundanceOverlay?.destroy?.();
    panelResize?.destroy?.();
    (await keySetup.catch(() => null))?.destroy();
  };
}
