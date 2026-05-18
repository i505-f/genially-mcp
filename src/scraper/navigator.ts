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
      '[class*="bullet"]',
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
    // Fallback: parse "X of N" / "X de N" / "X / N" text visible on the page
    // (e.g. Genially shows "Page 3 of 26" in the slide footer)
    const bodyText = document.body.innerText ?? '';
    const m = bodyText.match(/\b\d+\s*(?:of|de|\/)\s*(\d+)\b/i);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > 1) return n;
    }
    return 0;
  });
  return Math.max(count, 1);
}

export async function getCurrentSlideIndex(page: Page): Promise<number> {
  return page.evaluate(() => {
    const activeSelectors = [
      '[class*="dot"][class*="active"]',
      '[class*="dot"][class*="current"]',
      '[class*="bullet"][class*="active"]',
      '[class*="slide-indicator"] [class*="active"]',
    ];
    for (const sel of activeSelectors) {
      const active = document.querySelector(sel);
      if (active?.parentElement) {
        return Array.from(active.parentElement.children).indexOf(active);
      }
    }
    return 0;
  });
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
  const modalOpen = await page
    .locator('.ReactModal__Overlay')
    .isVisible({ timeout: 200 })
    .catch(() => false);
  if (modalOpen) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }

  const nextButtonSelectors = [
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
      await btn.click();
      buttonClicked = true;
      break;
    }
  }

  // Only use ArrowRight if no button was found at all
  if (!buttonClicked) {
    await page.keyboard.press('ArrowRight');
  }

  await page.waitForTimeout(1200);
  const fingerprintAfter = await getSlideTextFingerprint(page);
  return fingerprintAfter !== fingerprintBefore;
}

export async function navigateToSlideByIndex(page: Page, index: number): Promise<void> {
  await page.evaluate((idx) => {
    const dotSelectors = [
      '[class*="navigation-bar"] [class*="dot"]',
      '[class*="navigation-bar"] li',
      '[class*="nav-dots"] button',
      '[class*="pagination"] button',
      '[class*="bullet"]',
    ];
    for (const sel of dotSelectors) {
      const dots = document.querySelectorAll(sel);
      if (dots.length > idx) {
        (dots[idx] as HTMLElement).click();
        return;
      }
    }
  }, index);
  await page.waitForTimeout(1000);
}
