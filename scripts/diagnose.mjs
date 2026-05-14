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

await browser.close();
console.log('\n=== DONE ===\n');
