import { createWeatherClock } from './clock.js';
import { createWeatherLayer } from './index.js';
import { createWeatherSource } from './source.js';
import { createWindLayer } from '../wind/index.js';
import { createWindSource } from '../wind/source.js';
import { createCyclonesLayer } from '../cyclones/index.js';
import { createCycloneSource } from '../cyclones/source.js';

/**
 * Observed weather, wind, and cyclone advisories.
 * One clock is shared by the imagery products and the wind layer. These are
 * separate from the cockpit's Open-Meteo effects and from every CCTV source.
 */
export function createObservedWeatherLayers() {
  const clock = createWeatherClock();
  const weather = createWeatherSource();
  return [
    createWindLayer({ feed: createWindSource(), clock }),
    createWeatherLayer({ feed: weather, id: 'weather-radar', clock }),
    createWeatherLayer({ feed: weather, id: 'weather-satellite', clock }),
    createWeatherLayer({ feed: weather, id: 'weather-lightning', clock }),
    createCyclonesLayer({ feed: createCycloneSource() }),
  ];
}
