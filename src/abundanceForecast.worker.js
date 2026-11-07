// The GLOBAL ABUNDANCE MAP's forecast, off the page's thread: the tab sends
// a level's units and its settings (src/abundanceForecastRun.js), this
// simulates them (src/abundanceForecast.mjs) and posts the progress, the
// result and each selected place's detail back. The arithmetic lives in the
// shared module; this file only carries messages.
import { createForecastHandler } from './abundanceForecast.mjs';

const handle = createForecastHandler();

self.onmessage = (event) => {
  handle(event.data, (message, transfer) =>
    self.postMessage(message, transfer || []),
  );
};
