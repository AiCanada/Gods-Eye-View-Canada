#!/usr/bin/env node
/**
 * Mirror of PC GEVC on Cell: open the dashboard as each phone on the Ultra
 * list would (its screen, its density, touch), sideways and upright, and say
 * what a person on that screen gets: the layout, readable text, tap targets,
 * what the server refused, errors, and a screenshot.
 *
 *   node "Mirror of PC GEVC on Cell/phone-audit.mjs" http://<tailnet IP>:4173/ [out-folder] [phone-id ...]
 *
 * It drives this PC's own Chrome headless, so the globe is drawn in software:
 * load times are slower than on a phone, sizes and layout are exact.
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { PHONE_PROFILES, profileUserAgent } from './phone-profiles.mjs';

const [base, outArg, ...only] = process.argv.slice(2);
if (!base) {
  console.error(
    'usage: node "Mirror of PC GEVC on Cell/phone-audit.mjs" http://<tailnet IP>:4173/ [out-folder] [phone-id ...]',
  );
  process.exit(1);
}
const out = path.resolve(outArg || 'phone-audit');
fs.mkdirSync(out, { recursive: true });
const CHROME =
  process.env.CHROME_PATH ||
  (process.platform === 'win32'
    ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
    : '/usr/bin/google-chrome');

const phones = PHONE_PROFILES.filter(
  (p) => !only.length || only.includes(p.id),
);
const fileId = (p) => (p.screen ? `${p.id}-${p.screen}` : p.id);
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  protocolTimeout: 300_000,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const rows = [];
try {
  for (const phone of phones) {
    for (const sideways of [true, false]) {
      const page = await browser.newPage();
      await page.setUserAgent(profileUserAgent(phone));
      await page.setViewport({
        width: sideways ? phone.h : phone.w,
        height: sideways ? phone.w : phone.h,
        deviceScaleFactor: phone.dpr,
        isMobile: true,
        hasTouch: true,
        isLandscape: sideways,
      });
      const refused = new Set();
      const errors = [];
      page.on('response', (r) => {
        if (r.status() >= 400 && r.url().includes('/api/'))
          refused.add(`${r.status()} ${new URL(r.url()).pathname}`);
      });
      page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 120)));
      const started = Date.now();
      await page.goto(base, {
        waitUntil: 'domcontentloaded',
        timeout: 120_000,
      });
      await page
        .waitForFunction(
          () => {
            const l = document.getElementById('loading-screen');
            return (
              !l ||
              getComputedStyle(l).opacity === '0' ||
              getComputedStyle(l).display === 'none'
            );
          },
          { timeout: 120_000, polling: 500 },
        )
        .catch(() => {});
      const readyMs = Date.now() - started;
      await new Promise((r) => setTimeout(r, 6000));
      // A live reload (the PC saving a file) restarts the page: measure again once.
      const measure = () =>
        page.evaluate(() => {
          const scale = window.visualViewport ? window.visualViewport.scale : 1;
          const shown = (el) => {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return (
              r.width > 0 &&
              r.height > 0 &&
              s.visibility !== 'hidden' &&
              s.display !== 'none' &&
              Number(s.opacity) > 0.05
            );
          };
          const sizes = [];
          for (const el of document.querySelectorAll('body *')) {
            const own = [...el.childNodes].some(
              (n) => n.nodeType === 3 && n.textContent.trim().length > 1,
            );
            if (own && shown(el))
              sizes.push(parseFloat(getComputedStyle(el).fontSize) * scale);
          }
          sizes.sort((a, b) => a - b);
          let small = 0;
          let taps = 0;
          for (const el of document.querySelectorAll(
            'button, a[href], select, input',
          )) {
            if (!shown(el)) continue;
            taps += 1;
            const r = el.getBoundingClientRect();
            if (Math.min(r.width, r.height) * scale < 24) small += 1;
          }
          const chip = document.getElementById('key-setup-chip');
          const hint = document.getElementById('pc-mirror-hint');
          return {
            layout:
              document.documentElement.getAttribute('data-pc-mirror') === 'true'
                ? 'PC'
                : 'phone',
            width: document.documentElement.clientWidth,
            scale: Number(scale.toFixed(2)),
            textMedian: sizes.length
              ? Number(sizes[Math.floor(sizes.length / 2)].toFixed(1))
              : 0,
            textUnder9: sizes.filter((s) => s < 9).length,
            texts: sizes.length,
            smallTaps: small,
            taps,
            powerUpChip: Boolean(chip && chip.isConnected && !chip.hidden),
            powerUpLabel: chip?.textContent?.trim().slice(0, 40) || '',
            socialPowerUps:
              document.querySelector('.social-powerup')?.textContent?.trim() ||
              '',
            sidewaysHint: Boolean(hint && !hint.hidden),
            screenKind:
              document.documentElement.getAttribute('data-screen-kind') || '',
          };
        });
      let m;
      try {
        m = await measure();
      } catch {
        await new Promise((r) => setTimeout(r, 8000));
        try {
          m = await measure();
        } catch (error) {
          rows.push({
            phone: phone.label,
            held: sideways ? 'sideways' : 'upright',
            failed: String(error.message).slice(0, 80),
          });
          await page.close();
          continue;
        }
      }
      const shot = path.join(
        out,
        `${fileId(phone)}-${sideways ? 'sideways' : 'upright'}.png`,
      );
      await page
        .screenshot({
          path: shot,
          captureBeyondViewport: false,
          optimizeForSpeed: true,
        })
        .catch(() => {});
      rows.push({
        phone: phone.label,
        held: sideways ? 'sideways' : 'upright',
        readyMs,
        ...m,
        refused: [...refused],
        errors,
      });
      await page.close();
    }
  }
} finally {
  await browser.close();
}
fs.writeFileSync(
  path.join(out, 'phone-audit.json'),
  JSON.stringify(rows, null, 2),
);
for (const r of rows.filter((row) => !row.failed))
  console.log(
    `${r.phone.padEnd(30)} ${r.held.padEnd(8)} ${r.layout} ${r.width}px x${r.scale}  text ${r.textMedian}px (${r.textUnder9}/${r.texts} under 9px)  small taps ${r.smallTaps}/${r.taps}  POWER UP ${r.powerUpChip ? 'shown' : 'MISSING'}  refused ${r.refused.length}  errors ${r.errors.length}`,
  );
for (const r of rows.filter((row) => row.failed))
  console.log(
    `${r.phone.padEnd(30)} ${r.held.padEnd(8)} NOT MEASURED: ${r.failed}`,
  );
