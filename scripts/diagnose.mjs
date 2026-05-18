#!/usr/bin/env node
// Usage: node scripts/diagnose.mjs <url>
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'https://view.genially.com/6447530488c14a0018ca4004';

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
});
const page = await context.newPage();

console.log(`\n=== NAVIGATING TO ${url} ===`);
await page.goto(url, { waitUntil: 'load', timeout: 30000 });
await page.waitForTimeout(3000);

// ── 1. INITIAL_DATA ──────────────────────────────────────────────────────────
const initialData = await page.evaluate(() => {
  const w = window;
  const sp = w.INITIAL_DATA?.socialViewProps;
  if (!sp) return { found: false };

  const raw = sp.rawTranscriptions;
  const trans = sp.transcriptions;

  return {
    found: true,
    isVideo: w.INITIAL_DATA?.isVideo,
    rawTranscriptions: {
      exists: Array.isArray(raw),
      count: Array.isArray(raw) ? raw.length : 0,
      firstItemType: Array.isArray(raw) ? typeof raw[0] : 'n/a',
      firstItemPreview: Array.isArray(raw) && raw[0]
        ? (typeof raw[0] === 'string' ? raw[0].slice(0, 200) : JSON.stringify(raw[0]).slice(0, 200))
        : 'empty',
    },
    transcriptions: {
      exists: Array.isArray(trans),
      count: Array.isArray(trans) ? trans.length : 0,
      firstItemKeys: Array.isArray(trans) && trans[0] ? Object.keys(trans[0]) : [],
      firstItemPreview: Array.isArray(trans) && trans[0]
        ? JSON.stringify(trans[0]).slice(0, 300)
        : 'empty',
    },
  };
});
console.log('\n── INITIAL_DATA ──');
console.log(JSON.stringify(initialData, null, 2));

// ── 2. SLIDE COUNT DETECTION ─────────────────────────────────────────────────
const slideInfo = await page.evaluate(() => {
  const dotSelectors = [
    '[class*="navigation-bar"] [class*="dot"]',
    '[class*="navigation-bar"] li',
    '[class*="slide-indicator"] span',
    '[class*="nav-dots"] button',
    '[class*="pagination"] button',
    '[class*="bullet"]',
  ];
  const results = {};
  for (const sel of dotSelectors) {
    const els = document.querySelectorAll(sel);
    results[sel] = els.length;
  }
  const bodyText = document.body.innerText ?? '';
  const m = bodyText.match(/\b\d+\s*(?:of|de|\/)\s*(\d+)\b/i);
  results['body "X of N" match'] = m ? m[0] : 'none';
  return results;
});
console.log('\n── SLIDE COUNT SELECTORS ──');
console.log(JSON.stringify(slideInfo, null, 2));

// ── 3. NAVIGATE FORWARD AND LOG FINGERPRINTS ─────────────────────────────────
function fingerprint(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) >>> 0;
  return `${hash}:${text.length}`;
}

const nextSelectors = [
  '[class*="next"]:not([class*="navigation-bar"])',
  '[class*="arrow-right"]',
  '[aria-label*="next" i]',
  '[aria-label*="siguiente" i]',
  '[title*="next" i]',
];

async function getFP() {
  const text = await page.evaluate(() => document.body.innerText ?? '');
  return fingerprint(text);
}

async function clickNext() {
  for (const sel of nextSelectors) {
    const btn = page.locator(sel).first();
    const visible = await btn.isVisible({ timeout: 300 }).catch(() => false);
    if (visible) { await btn.click(); return `button:${sel}`; }
  }
  await page.keyboard.press('ArrowRight');
  return 'ArrowRight';
}

console.log('\n── NAVIGATION (15 steps) ──');
const firstFP = await getFP();
let prevFP = firstFP;
console.log(`start  fp=${firstFP}`);

for (let i = 1; i <= 15; i++) {
  const method = await clickNext();
  await page.waitForTimeout(1400);
  const fp = await getFP();
  const changed = fp !== prevFP;
  const looped = fp === firstFP;
  console.log(`step ${String(i).padStart(2)}: ${changed ? 'CHANGED' : 'SAME   '} ${looped ? '(LOOPED)' : '       '} via=${method} fp=${fp}`);
  prevFP = fp;
}

// ── 4. INTERACTIVE ELEMENTS ON CURRENT SLIDE ─────────────────────────────────
const interactives = await page.evaluate(() => {
  const selectors = [
    '[class*="hotspot"]', '[class*="hot-spot"]', '[class*="interactivity"]',
    '[data-animation]', '[data-genially-type]', '[data-genially-interactivity]',
    '[class*="pulse"]', '[class*="ping"]', '[class*="marker"]', '[onclick]',
    '[class*="interactive"]', '[class*="tooltip"]', '[class*="popup"]',
  ];
  const found = [];
  const seen = new Set();
  for (const sel of selectors) {
    document.querySelectorAll(sel).forEach(el => {
      if (seen.has(el)) return;
      seen.add(el);
      const rect = el.getBoundingClientRect();
      if (rect.width < 5 || rect.height < 5) return;
      found.push({
        sel,
        tag: el.tagName,
        class: el.className.toString().slice(0, 80),
        attrs: [...el.attributes].map(a => `${a.name}=${a.value}`).slice(0, 5).join(' '),
        text: el.textContent?.trim().slice(0, 50),
      });
    });
  }
  return found.slice(0, 30);
});
console.log('\n── INTERACTIVE ELEMENTS (current slide, up to 30) ──');
if (interactives.length === 0) console.log('  none found');
interactives.forEach((el, i) => console.log(`  [${i}] sel=${el.sel} tag=${el.tag} class="${el.class}" text="${el.text}"`));

// ── 5. ALL VISIBLE BUTTONS / CLICKABLE ELEMENTS ──────────────────────────────
const cursors = await page.evaluate(() => {
  const results = [];
  document.querySelectorAll('button, [role="button"], a[href="#"], [tabindex]').forEach(el => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 5 || rect.height < 5) return;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return;
    results.push({
      tag: el.tagName,
      class: el.className.toString().slice(0, 60),
      text: el.textContent?.trim().slice(0, 40),
      ariaLabel: el.getAttribute('aria-label'),
      role: el.getAttribute('role'),
    });
  });
  return results.slice(0, 30);
});
console.log('\n── BUTTONS / ROLE=BUTTON (current slide, up to 30) ──');
if (cursors.length === 0) console.log('  none found');
cursors.forEach((el, i) => console.log(`  [${i}] ${el.tag} class="${el.class}" text="${el.text}" aria="${el.ariaLabel}"`));

// ── 6. DOM STRUCTURE PROBE: how does Genially mark interactive content? ──
console.log('\n── DOM STRUCTURE PROBE ──');
await page.goto(url, { waitUntil: 'load', timeout: 30000 });
await page.waitForTimeout(3500);

// 6a. iframes?
const frames = page.frames().map((f) => f.url());
console.log(`  page.frames(): ${frames.length}`);
frames.forEach((u, i) => console.log(`    [${i}] ${u.slice(0, 120)}`));

const iframeInfo = await page.evaluate(() => {
  return [...document.querySelectorAll('iframe')].map((f) => ({
    src: f.src.slice(0, 120),
    cls: f.className.toString().slice(0, 80),
    w: Math.round(f.getBoundingClientRect().width),
    h: Math.round(f.getBoundingClientRect().height),
  }));
});
console.log(`  <iframe> elements: ${iframeInfo.length}`);
iframeInfo.forEach((f, i) => console.log(`    [${i}] ${f.w}x${f.h} class="${f.cls}" src="${f.src}"`));

// Use the proven next-button to navigate (ArrowRight may not have focus)
async function clickNextBtn() {
  for (const sel of ['[aria-label*="next" i]', '[class*="arrow-right"]', '[class*="next"]']) {
    const b = page.locator(sel).first();
    if (await b.isVisible({ timeout: 300 }).catch(() => false)) {
      await b.click().catch(() => {});
      return true;
    }
  }
  return false;
}

const SYSTEM = /go to the (next|prev)|full.?screen|^share$|audio|show interactive|previous page|next page/i;

// Probe slides 1..6 — dump every element whose COMPUTED cursor is pointer
for (let s = 1; s <= 6; s++) {
  const dump = await page.evaluate((sysSrc) => {
    const sysRe = new RegExp(sysSrc, 'i');
    const out = [];
    const seen = new Set();
    document.querySelectorAll('body *').forEach((el) => {
      const cs = getComputedStyle(el);
      if (cs.cursor !== 'pointer') return;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || r.width > 1400) return;
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      const aria = el.getAttribute('aria-label') || '';
      const txt = (el.textContent || '').trim().slice(0, 40);
      const desc = aria || txt;
      if (sysRe.test(desc)) return;
      const key = `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        tag: el.tagName,
        cls: el.className.toString().slice(0, 70),
        aria,
        txt,
        attrs: [...el.attributes].map((a) => a.name).join(','),
        pos: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`,
      });
    });
    return out.slice(0, 12);
  }, SYSTEM.source);

  const counter = await page.evaluate(() => {
    const m = (document.body.innerText || '').match(/\b(\d+)\s*(?:of|de|\/)\s*(\d+)\b/i);
    return m ? `${m[1]}/${m[2]}` : '?';
  });

  console.log(`\n  ── slide ${s} (counter ${counter}): ${dump.length} cursor:pointer content elements ──`);
  dump.forEach((d, i) =>
    console.log(`    [${i}] <${d.tag}> "${d.txt || d.aria}" cls="${d.cls}" attrs=[${d.attrs}] @${d.pos}`),
  );

  // Click EVERY clickable genially-view-item on this slide; after each click look
  // for a REAL popup: a visible container with text that was NOT there before,
  // excluding the canvasInteractivityEffect ripple layer and viewer chrome.
  const targets = await page.evaluate(
    (sysSrc) => {
      const sysRe = new RegExp(sysSrc, 'i');
      const added = [];
      const out = [];
      for (const el of document.querySelectorAll('[class*="genially-view-item"], [data-genially-id]')) {
        const cs = getComputedStyle(el);
        if (cs.cursor !== 'pointer') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8 || r.width > 1400) continue;
        if (added.some((a) => a.contains(el))) continue;
        const desc = el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 40) || 'item';
        if (sysRe.test(desc)) continue;
        added.push(el);
        out.push({ x: r.x + r.width / 2, y: r.y + r.height / 2, desc });
      }
      return out.slice(0, 10);
    },
    SYSTEM.source,
  );

  for (const t of targets) {
    const before = await page.evaluate(() => document.body.innerText.length);
    await page.mouse.click(t.x, t.y);
    await page.waitForTimeout(1600);

    const found = await page.evaluate((beforeLen) => {
      const CHROME = /genially-view-(icon|cursor-pointer|navigation|footer|header|background_audio|toolbar)|StickyBanner|sc-/;
      let best = null;
      let bestArea = 0;
      document.querySelectorAll('body *').forEach((n) => {
        if (n.tagName === 'CANVAS' || n.tagName === 'SCRIPT' || n.tagName === 'STYLE') return;
        if (n.getAttribute && n.getAttribute('data-cy') === 'canvasInteractivityEffect') return;
        const cs = getComputedStyle(n);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return;
        const r = n.getBoundingClientRect();
        if (r.width < 180 || r.height < 100) return;
        const txt = (n.innerText || '').trim();
        if (txt.length < 25) return;
        const cls = n.className ? n.className.toString() : '';
        if (CHROME.test(cls)) return;
        // Heuristic: a popup container has its own text and a high-ish z-index or is a dialog/modal
        const z = parseInt(cs.zIndex, 10) || 0;
        const looksPopup =
          z > 10 ||
          /modal|popup|window|dialog|ReactModal|tooltip|overlay/i.test(cls) ||
          n.getAttribute('role') === 'dialog';
        if (!looksPopup) return;
        const area = r.width * r.height;
        // Prefer the smallest qualifying container (the popup itself, not a huge wrapper)
        if (best === null || area < bestArea) {
          best = n;
          bestArea = area;
        }
      });
      if (!best) return null;
      return {
        bodyTextGrew: document.body.innerText.length > beforeLen + 20,
        tag: best.tagName,
        cls: (best.className ? best.className.toString() : '').slice(0, 140),
        role: best.getAttribute('role'),
        zIndex: getComputedStyle(best).zIndex,
        innerText: (best.innerText || '').slice(0, 1200),
        outerHTML: best.outerHTML.slice(0, 2400),
      };
    }, before);

    if (found && found.innerText && found.innerText.trim().length > 20) {
      console.log(`\n  >>> POPUP FOUND after clicking "${t.desc}" on slide ${s}`);
      console.log(`  container: <${found.tag}> role=${found.role} z=${found.zIndex} class="${found.cls}"`);
      console.log(`  bodyTextGrew: ${found.bodyTextGrew}`);
      console.log('  --- popup innerText ---\n' + found.innerText);
      console.log('\n  --- popup outerHTML (2.4k) ---\n' + found.outerHTML);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(700);
      const reactStillOpen = await page
        .locator('.ReactModal__Overlay')
        .isVisible({ timeout: 300 })
        .catch(() => false);
      console.log(`\n  Escape closed ReactModal overlay? ${!reactStillOpen}`);
      await browser.close();
      console.log('\n=== DONE (popup captured) ===\n');
      process.exit(0);
    }

    // No popup → likely navigation or pure animation. Restore: Escape, and if the
    // slide changed, go back so the remaining targets stay aligned.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    const afterLen = await page.evaluate(() => document.body.innerText.length);
    if (Math.abs(afterLen - before) > 50) {
      for (const sel of ['[aria-label*="previous" i]', '[aria-label*="Go to the prev" i]']) {
        const b = page.locator(sel).first();
        if (await b.isVisible({ timeout: 250 }).catch(() => false)) {
          await b.click().catch(() => {});
          break;
        }
      }
      await page.waitForTimeout(900);
    }
  }

  await clickNextBtn();
  await page.waitForTimeout(1400);
}

console.log('\n  (no popup found across probed slides)');

await browser.close();
console.log('\n=== DONE ===\n');
