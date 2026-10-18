import { Page } from 'playwright';
import { log } from '../utils/logger.js';

export async function waitForPresentation(page: Page, timeoutMs: number): Promise<void> {
  // 'load' is more reliable than 'networkidle' — Genially has continuous analytics traffic
  await page.waitForLoadState('load', { timeout: timeoutMs });
  await page
    .waitForSelector(
      '[class*="slide"], [class*="genially"], section[data-genially-id], .genially-view-window',
      { timeout: Math.min(timeoutMs, 15000), state: 'attached' },
    )
    .catch(() => {
      log.warn('No specific Genially slide container found, continuing with full page');
    });
  await page.waitForTimeout(2000);
}

export async function getSlideCount(page: Page): Promise<number> {
  const count = await page.evaluate(() => {
    const dotSelectors = [
      '[class*="navigation-bar"] [class*="dot"]',
      '[class*="navigation-bar"] li',
      '[class*="slide-indicator"] span',
      '[class*="nav-dots"] button',
      '[class*="pagination"] button',
    ];
    for (const sel of dotSelectors) {
      const items = document.querySelectorAll(sel);
      if (items.length > 1) return items.length;
    }
    const slideSelectors = [
      'section[class*="slide"]',
      '[class*="genially-slide"]',
      '[data-genially-slide-index]',
    ];
    for (const sel of slideSelectors) {
      const items = document.querySelectorAll(sel);
      if (items.length > 0) return items.length;
    }
    return 0;
  });
  if (count > 0) return count;
  // Fallback: the page counter (e.g. Genially shows "Page 3 of 26" in the slide footer)
  const { total } = await getPageInfo(page).catch(() => ({ total: null as number | null }));
  return Math.max(total ?? 0, 1);
}

// Reads the slide footer counter. Slide content often contains "N/M"-shaped text
// (school years, fractions, dates), so only the explicit "Page N of M" form or an
// element whose entire text is "N of M" / "N / M" counts.
export async function getPageInfo(page: Page): Promise<{ current: number | null; total: number | null }> {
  return page.evaluate(() => {
    const valid = (current: number, total: number): boolean => current >= 1 && total >= current && total <= 500;

    const bodyText = document.body.innerText ?? '';
    for (const m of bodyText.matchAll(/\b(?:page|p[áa]gina)\s+(\d+)\s+(?:of|de)\s+(\d+)\b/gi)) {
      const current = parseInt(m[1], 10);
      const total = parseInt(m[2], 10);
      if (valid(current, total)) return { current, total };
    }

    // Document order puts descendants after ancestors, so the last match is the
    // innermost element of a wrapper chain and, usually, the footer counter
    const COUNTER = /^(\d+)\s*(?:of|de|\/)\s*(\d+)$/i;
    let found: { current: number; total: number } | null = null;
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      const text = el.textContent?.trim() ?? '';
      if (text.length === 0 || text.length > 24) continue;
      const m = text.match(COUNTER);
      if (!m || !el.checkVisibility()) continue;
      const current = parseInt(m[1], 10);
      const total = parseInt(m[2], 10);
      if (valid(current, total)) found = { current, total };
    }
    return found ?? { current: null, total: null };
  });
}

const MODAL_OVERLAY = '.ReactModal__Overlay';

export async function isModalOpen(page: Page): Promise<boolean> {
  return page.locator(MODAL_OVERLAY).first().isVisible({ timeout: 250 }).catch(() => false);
}

// Genially modals are often configured with shouldCloseOnEsc=false and their close
// control is a <div class="genially-view-cursor-pointer"> (not a <button>), so a
// single Escape press is not enough. Try Escape, then an explicit close control,
// then a backdrop click (shouldCloseOnOverlayClick), repeating a few times.
export async function dismissAnyModal(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!(await isModalOpen(page))) return;

    await page.keyboard.press('Escape');
    await page.waitForTimeout(350);
    if (!(await isModalOpen(page))) return;

    const closeSelectors = [
      `${MODAL_OVERLAY} [aria-label*="close" i]`,
      `${MODAL_OVERLAY} [aria-label*="cerrar" i]`,
      `${MODAL_OVERLAY} [class*="close"]`,
      '.ReactModal__Content button',
    ];
    for (const sel of closeSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 150 }).catch(() => false)) {
        await btn.click({ timeout: 1000 }).catch(() => {});
        await page.waitForTimeout(350);
        break;
      }
    }
    if (!(await isModalOpen(page))) return;

    // Backdrop click at a top-left corner, away from the modal content
    const box = await page.locator(MODAL_OVERLAY).first().boundingBox().catch(() => null);
    if (box) {
      await page.mouse.click(box.x + 4, box.y + 4).catch(() => {});
      await page.waitForTimeout(350);
    }
  }
}

export async function getSlideTextFingerprint(page: Page): Promise<string> {
  return page.evaluate(() => {
    // Use a hash of the full body text so persistent headers don't cause false loop detection
    const text = document.body.innerText ?? '';
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) >>> 0;
    }
    return `${hash}:${text.length}`;
  });
}

export async function navigateToNextSlide(page: Page): Promise<boolean> {
  // Dismiss any blocking modal before attempting navigation
  await dismissAnyModal(page);

  // Genially uses two aria-label patterns for the next-slide button:
  //  1. Generic: "Go to the next page" / "Empezar, Go to the next page"
  //  2. Slide-specific numeric: "Go to page N" / "Ir a la página N"
  // Compute the slide-specific selector from the page counter — a broader
  // [aria-label*="Go to page"] would also match "Go to first page" and any
  // content-level jump links on hub/TOC slides.
  const { current } = await getPageInfo(page).catch(() => ({ current: null as number | null }));
  const dynamicSelectors =
    current != null
      ? [
          `[aria-label="Go to page ${current + 1}"]`,
          `[aria-label="Ir a la página ${current + 1}"]`,
        ]
      : [];

  const nextButtonSelectors = [
    ...dynamicSelectors,
    '[class*="next"]:not([class*="navigation-bar"])',
    '[class*="arrow-right"]',
    '[aria-label*="next" i]',
    '[aria-label*="siguiente" i]',
    '[title*="next" i]',
  ];

  const fingerprintBefore = await getSlideTextFingerprint(page);

  // Click at most ONE button — iterating all selectors caused double-navigation
  // when the first click succeeded but the 900ms transition hadn't finished yet
  let buttonClicked = false;
  for (const sel of nextButtonSelectors) {
    const btn = page.locator(sel).first();
    const visible = await btn.isVisible({ timeout: 300 }).catch(() => false);
    if (visible) {
      let ok = await btn
        .click({ timeout: 2000 })
        .then(() => true)
        .catch(() => false);
      // Cover screens have a sibling .sc-* (styled-component) layer that
      // intercepts pointer events at the button's coordinates. force:true
      // still routes through that overlay, so dispatch the React onClick
      // handler directly on the element via JS.
      if (!ok) {
        ok = await btn
          .evaluate((el) => (el as HTMLElement).click())
          .then(() => true)
          .catch(() => false);
      }
      buttonClicked = ok;
      break;
    }
  }

  // ArrowRight fallback — focus the viewer first so the key event reaches it
  if (!buttonClicked) {
    await page
      .evaluate(() => {
        const viewer = document.querySelector<HTMLElement>(
          '.genially-view-window, [class*="genially-view"]',
        );
        viewer?.focus?.();
      })
      .catch(() => {});
    await page.keyboard.press('ArrowRight');
  }

  await page.waitForTimeout(1200);
  const fingerprintAfter = await getSlideTextFingerprint(page);
  return fingerprintAfter !== fingerprintBefore;
}
