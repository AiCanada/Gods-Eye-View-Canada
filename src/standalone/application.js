import { createStandaloneCatalog } from './catalog.js';
import { createStandalonePlaceSearch } from './placeSearch.js';
import { CITY_POIS } from '../cityPois.js';
import { createApplication } from '../app/application.js';
import { createStandaloneScene } from './scene.js';
import { createStandaloneControls } from './controls.js';
import { createStandaloneData } from './data.js';
import { createStandaloneTools } from './tools.js';
import { resolveLocale, applyDocumentLanguage } from '../i18n/locale.js';
import {
  applyDocumentTranslations,
  getLocale,
  loadCatalog,
  onLocaleChange,
  setLocale,
} from '../i18n/index.js';
import { installEnglishHint } from '../ui/englishHint.js';
import { mountApplicationViews } from '../ui/views/index.js';
import { createGoogleTokenSource } from '../maps/googleTokens.js';

// The existing controls and layer catalog contain page-scoped state.
let constructed = false;

/** Compose the standalone application once per page. Reload to start again. */
export function createStandaloneApplication({
  googleApiKey,
  cesiumToken,
  geospatial = {},
  voice = {},
  sources = {},
  streetLevelProviders,
  allowQaRegistration = false,
}) {
  if (constructed)
    throw new Error('The standalone application already owns this page');
  constructed = true;
  // Locale is resolved before any UI initialization so <html lang>/<html dir>
  // and every catalog lookup agree from the first painted frame. Module
  // scripts execute after parsing, so the DOM is ready here: the views
  // translate as they render, and the page's static data-i18n* markup (the
  // loading screen) is translated here and after every language switch.
  const activeLocale = resolveLocale();
  setLocale(activeLocale);
  applyDocumentLanguage(document, activeLocale);
  // Views render the page's markup; wiring reads it. They translate as they
  // render: before the active locale's catalog lands they read English, and
  // they render again when it does (src/i18n/index.js), under the loading
  // screen.
  mountApplicationViews(document);
  // Ancient Egyptian and Inuktitut: a two-second mouse rest shows the
  // English. The hint follows the language, so a switch in place installs,
  // rebuilds or removes it.
  let englishHint = null;
  const syncEnglishHint = () => {
    englishHint?.destroy();
    englishHint = installEnglishHint({ locale: getLocale() });
  };
  // The catalog is one file, the active locale's, fetched now and awaited
  // before the scene is built, so the static data-i18n* markup and every
  // lookup agree before the loading screen lifts; a page read in English
  // waits for nothing.
  const localeReady = loadCatalog(activeLocale)
    .catch((error) => {
      console.warn(
        `[i18n] the ${activeLocale} catalog did not load:`,
        error?.message || error,
      );
      return null;
    })
    .then(() => {
      applyDocumentTranslations(document);
      syncEnglishHint();
    });
  const loadingScreen = document.getElementById('loading-screen');
  const loaderStatus = loadingScreen.querySelector('.loader-status');
  let placeSearch;
  let catalog;
  return createApplication({
    createScene: async (context) => {
      await localeReady;
      // A language switch applies in place, and so does a catalog landing;
      // the page's own markup and the English hover help follow.
      context.defer(
        onLocaleChange(() => {
          applyDocumentLanguage(document, getLocale());
          applyDocumentTranslations(document);
          syncEnglishHint();
        }),
      );
      context.defer(() => englishHint?.destroy());
      placeSearch = createStandalonePlaceSearch({
        // The bundled city and landmark data the offline name provider reads.
        // The search package takes it as plain data rather than importing it,
        // so it stays free of application state.
        presets: CITY_POIS,
        ...geospatial,
        resolveApiKey: () => googleApiKey,
        signal: context.signal,
      });
      const scene = await createStandaloneScene({
        ...context,
        googleApiKey,
        // Without a key, Google 3D can still load with tokens from the
        // app's server when it offers them.
        googleTokens: googleApiKey ? null : createGoogleTokenSource(),
        cesiumToken,
        loaderStatus,
      });
      catalog = createStandaloneCatalog({
        sources,
        streetLevelProviders,
        nepalBoundaryResolver: (signal) =>
          scene.operations.annotationResolver.resolveRegionRingForQuery(
            'Nepal',
            signal,
            placeSearch,
            // The locator draws the border whenever it arrives.
            { budgetMs: Infinity },
          ),
        signal: context.signal,
        surface: scene.operations.surface,
      });
      return scene;
    },
    createControls: (context) =>
      createStandaloneControls({
        ...context,
        loaderStatus,
        placeSearch,
        catalog,
      }),
    createData: (context) =>
      createStandaloneData({ ...context, allowQaRegistration, catalog }),
    createTools: (context) =>
      createStandaloneTools({ ...context, loadingScreen, placeSearch, voice }),
  });
}
