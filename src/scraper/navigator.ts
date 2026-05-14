import { Page } from 'playwright';
import { log } from '../utils/logger.js';

export async function waitForPresentation(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: timeoutMs });
  await page
    .waitForSelector(
      '[class*="slide"], [class*="genially"], section[data-genially-id], .genially-view-window',
      { timeout: timeoutMs, state: 'attached' },
    )
    .catch(() => {
      // Fallback: just wait for load if no specific selector is found
      log.warn('No specific Genially slide container found, continuing with full page');
    });
  await page.waitForTimeout(1500);
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
  const text = await page.evaluate(() => {
    return (document.body.innerText ?? '').slice(0, 500);
  });
  return text;
}

export async function navigateToNextSlide(page: Page): Promise<boolean> {
  const nextButtonSelectors = [
    '[class*="next"]:not([class*="navigation-bar"])',
    '[class*="arrow-right"]',
    '[aria-label*="next" i]',
    '[aria-label*="siguiente" i]',
    '[title*="next" i]',
  ];

  const indexBefore = await getCurrentSlideIndex(page);
  const fingerprintBefore = await getSlideTextFingerprint(page);

  for (const sel of nextButtonSelectors) {
    const btn = page.locator(sel).first();
    const visible = await btn.isVisible({ timeout: 300 }).catch(() => false);
    if (visible) {
      await btn.click();
      await page.waitForTimeout(900);
      const fingerprintAfter = await getSlideTextFingerprint(page);
      if (fingerprintAfter !== fingerprintBefore) return true;
    }
  }

  // Fallback: ArrowRight key
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(900);

  const indexAfter = await getCurrentSlideIndex(page);
  const fingerprintAfter = await getSlideTextFingerprint(page);

  return indexAfter !== indexBefore || fingerprintAfter !== fingerprintBefore;
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
