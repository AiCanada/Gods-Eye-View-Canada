import { test } from 'node:test';
import assert from 'node:assert/strict';

import { A22_IMAGE_ORIGIN } from '../../server/providers/cctv/constants.js';
import { fetchWithinHost } from '../../server/providers/cctv/media.js';

// The fork's international pack holds the 13 Autostrada del Brennero (A22)
// webcams, so upstream's live A22 loader (#956) is left out. Its frame pin
// stays: the pack's stills come through the same frame proxy.
test('a redirect on the A22 frame host stays inside WebCamImg/', async () => {
  const frame = `${A22_IMAGE_ORIGIN}km68.jpg`;
  const redirectTo = (location) => async (url) =>
    url === frame
      ? new Response(null, { status: 302, headers: { location } })
      : new Response('frame', { headers: { 'content-type': 'image/jpeg' } });
  for (const location of ['/it/area-riservata/', '/WebCamImg/../x.jpg'])
    assert.equal(
      await fetchWithinHost(frame, {}, redirectTo(location)),
      null,
      location,
    );
  const followed = await fetchWithinHost(
    frame,
    {},
    redirectTo('/WebCamImg/km77.jpg'),
  );
  assert.equal(await followed.text(), 'frame');
});
