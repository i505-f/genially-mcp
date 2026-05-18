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

// ── 6. PROBE A REAL POPUP: reload, advance to a slide with a hotspot, click it ──
console.log('\n── POPUP PROBE ──');
await page.goto(url, { waitUntil: 'load', timeout: 30000 });
await page.waitForTimeout(3500);

// Advance a few slides to reach interactive content (e.g. slide ~4 with "+Info")
for (let i = 0; i < 3; i++) {
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(1300);
}

const SYSTEM = /^(go to the (next|prev)|full.?screen|share|audio|show interactive)/i;
const target = await page.evaluate((sysSrc) => {
  const sysRe = new RegExp(sysSrc, 'i');
  const sels = [
    '[class*="hotspot"]', '[class*="interactivity"]', '[data-animation]',
    '[class*="interactive"]', '[onclick]', '[class*="genially-view-cursor-pointer"]',
  ];
  for (const sel of sels) {
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width < 5 || r.height < 5) continue;
      const desc = el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 40) || el.className.toString().slice(0, 40);
      if (sysRe.test(desc)) continue;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, desc };
    }
  }
  return null;
}, SYSTEM.source);

if (!target) {
  console.log('  no clickable hotspot found on this slide');
} else {
  console.log(`  clicking target: "${target.desc}" at (${Math.round(target.x)}, ${Math.round(target.y)})`);
  await page.mouse.click(target.x, target.y);
  await page.waitForTimeout(1500);

  const probe = await page.evaluate(() => {
    const overlay = document.querySelector('.ReactModal__Overlay');
    const content = document.querySelector('.ReactModal__Content');
    const el = content || overlay;
    // Highest z-index element that is large and visible (potential popup container)
    let topZ = null, topZVal = -1;
    document.querySelectorAll('body *').forEach((n) => {
      const cs = getComputedStyle(n);
      const z = parseInt(cs.zIndex, 10);
      const r = n.getBoundingClientRect();
      if (!isNaN(z) && z > topZVal && r.width > 150 && r.height > 100 && cs.display !== 'none' && cs.visibility !== 'hidden') {
        topZVal = z; topZ = n;
      }
    });
    return {
      reactModalOverlay: !!overlay,
      reactModalContent: !!content,
      modalOuterHTML: el ? el.outerHTML.slice(0, 2500) : null,
      modalInnerText: el ? el.innerText.slice(0, 1500) : null,
      topZIndex: topZVal,
      topZClass: topZ ? topZ.className.toString().slice(0, 120) : null,
      topZTag: topZ ? topZ.tagName : null,
      topZInnerText: topZ ? topZ.innerText.slice(0, 1500) : null,
      topZOuterHTMLHead: topZ ? topZ.outerHTML.slice(0, 1200) : null,
    };
  });
  console.log(`  .ReactModal__Overlay present: ${probe.reactModalOverlay}`);
  console.log(`  .ReactModal__Content present: ${probe.reactModalContent}`);
  console.log(`  highest z-index overlay: z=${probe.topZIndex} <${probe.topZTag}> class="${probe.topZClass}"`);
  console.log('\n  --- modal innerText ---\n' + (probe.modalInnerText ?? '(none)'));
  console.log('\n  --- modal outerHTML (2.5k) ---\n' + (probe.modalOuterHTML ?? '(none)'));
  console.log('\n  --- top-z innerText ---\n' + (probe.topZInnerText ?? '(none)'));
  console.log('\n  --- top-z outerHTML head ---\n' + (probe.topZOuterHTMLHead ?? '(none)'));

  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
  const stillOpen = await page.locator('.ReactModal__Overlay').isVisible({ timeout: 300 }).catch(() => false);
  console.log(`\n  Escape closed the modal? ${!stillOpen} (overlay still visible: ${stillOpen})`);
}

await browser.close();
console.log('\n=== DONE ===\n');
