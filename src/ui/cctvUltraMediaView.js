/**
 * An Ultra cell photo or video in the CCTV viewer on the right (owner ruling,
 * 2026-10-08): one click on its tile on the map, or CCTV in the Ultra box's
 * list, lays it over the camera picture. ✕ BACK TO CAMERA takes it away and
 * the camera picture is there again, untouched underneath.
 */
import { ultraMediaNames, ultraMediaUrl } from '../deviceFeedsCore.mjs';

const VIEW_ID = 'cctv-ultra-view';

/** When a saved name says it was taken, in this computer's local time. */
function takenAt(name) {
  const match = /-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/.exec(name);
  if (!match) return '';
  const [, y, mo, d, h, mi, s] = match.map(Number);
  const at = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleString();
}

/** Close the Ultra photo or video; the camera picture shows again. */
export function closeUltraMediaInCctv(documentRef = document) {
  const view = documentRef.getElementById?.(VIEW_ID);
  if (!view) return;
  const video = view.querySelector?.('video');
  try {
    video?.pause?.();
    video?.removeAttribute?.('src');
    video?.load?.();
  } catch {
    /* already gone */
  }
  view.remove?.();
}

/**
 * Show a saved photo or video in the CCTV viewer, opening the CCTV box if it
 * is collapsed. Only names the server saves are accepted.
 * @returns {boolean} Whether it is showing.
 */
export function showUltraMediaInCctv(
  documentRef = document,
  { name, kind } = {},
) {
  const [clean] = ultraMediaNames([name]);
  const wrap = documentRef.getElementById?.('cctv-frame-wrap');
  if (!clean || !wrap) return false;
  const isVideo = kind === 'clip' || clean.startsWith('clip-');
  closeUltraMediaInCctv(documentRef);
  const view = documentRef.createElement('div');
  view.id = VIEW_ID;
  view.className = 'cctv-ultra-view';
  const bar = documentRef.createElement('div');
  bar.className = 'cctv-ultra-bar';
  const label = documentRef.createElement('span');
  label.textContent = `ULTRA ${isVideo ? 'VIDEO' : 'PHOTO'} · ${takenAt(clean)}`;
  const back = documentRef.createElement('button');
  back.type = 'button';
  back.className = 'scene-btn';
  back.textContent = '✕ BACK TO CAMERA';
  back.addEventListener('click', () => closeUltraMediaInCctv(documentRef));
  bar.appendChild(label);
  bar.appendChild(back);
  const media = documentRef.createElement(isVideo ? 'video' : 'img');
  media.className = 'cctv-ultra-media';
  if (isVideo) {
    media.controls = true;
    media.autoplay = true;
    media.muted = true;
    media.loop = true;
    media.playsInline = true;
  } else {
    media.alt = 'Ultra cell photo';
  }
  media.src = ultraMediaUrl(clean);
  view.appendChild(bar);
  view.appendChild(media);
  wrap.appendChild(view);
  if (isVideo) media.play?.()?.catch?.(() => {});
  // A collapsed CCTV box opens, the way its own button opens it.
  const panel = documentRef.getElementById?.('cctv-panel');
  if (panel?.classList?.contains('collapsed')) {
    panel
      .querySelector?.('.panel-collapse-btn[data-collapse-target="cctv-panel"]')
      ?.click?.();
  }
  return true;
}
