import { Page } from 'playwright';
import { PopupContent, SlideImage } from './types.js';
import { log } from '../utils/logger.js';
import { getSlideTextFingerprint } from './navigator.js';

interface ClickTarget {
  description: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

// Labels that identify Genially viewer chrome (navigation / toolbar) — never content hotspots
const SYSTEM_LABEL = /^(go to the (next|prev)|full.?screen|share|audio|show interactive)/i;

export async function findClickTargets(page: Page): Promise<ClickTarget[]> {
  return page.evaluate((systemPattern: string): ClickTarget[] => {
    const systemRe = new RegExp(systemPattern, 'i');

    const interactiveSelectors = [
      '[class*="hotspot"]',
      '[class*="hot-spot"]',
      '[class*="interactivity-button"]',
      '[class*="interactive-area"]',
      '[class*="element-button"]',
      '[class*="element-interactive"]',
      '[class*="interactivity"]',
      '[data-animation]',
      '[data-genially-type="button"]',
      '[data-genially-type="hotspot"]',
      '[data-genially-interactivity]',
      '[class*="tooltip-trigger"]',
      '[class*="popup-trigger"]',
      '[class*="interactive"]',
      '[class*="genially-view-hotspot"]',
      '[class*="pulse"]',
      '[class*="ping"]',
      '[class*="marker"]',
      '[onclick]',
      '[class*="genially-view-cursor-pointer"]',
    ];

    const byPosition = new Map<string, ClickTarget>();

    for (const sel of interactiveSelectors) {
      document.querySelectorAll(sel).forEach((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 5 || rect.height < 5) return;

        const desc =
          el.getAttribute('aria-label') ||
          el.getAttribute('title') ||
          el.textContent?.trim().slice(0, 60) ||
          el.className.toString().slice(0, 50) ||
          'interactive element';

        if (systemRe.test(desc)) return;

        const key = `${Math.round(rect.x / 5) * 5},${Math.round(rect.y / 5) * 5}`;
        if (byPosition.has(key)) return;
        byPosition.set(key, { description: desc, x: rect.x, y: rect.y, width: rect.width, height: rect.height });
      });
    }

    return [...byPosition.values()].slice(0, 20);
  }, SYSTEM_LABEL.source);
}

async function isModalOpen(page: Page): Promise<boolean> {
  // Check .ReactModal__Overlay (without --after-open) so we catch it during animations too
  return page.locator('.ReactModal__Overlay').isVisible({ timeout: 300 }).catch(() => false);
}

async function captureOpenPopup(page: Page): Promise<PopupContent | null> {
  return page.evaluate((): { triggerDescription: string; text: string[]; images: SlideImage[] } | null => {
    const popupSelectors = [
      '.ReactModal__Content',
      '[class*="genially-view-modal"]',
      '[class*="genially-modal"]',
      '[role="dialog"]',
      '[class*="modal"][class*="open"]',
      '[class*="modal"][class*="active"]',
      '[class*="modal"][class*="show"]',
      '[class*="modal"][class*="visible"]',
      '[class*="popup"][class*="visible"]',
      '[class*="overlay"][class*="active"]',
      '[class*="tooltip"][class*="show"]',
      '[class*="tooltip"][class*="visible"]',
      '[class*="genially-view-content"]',
      '[class*="genially-view-panel"]',
      '[class*="genially-view-window"]',
    ];

    for (const sel of popupSelectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

      const texts: string[] = [];
      const images: SlideImage[] = [];

      el.querySelectorAll('p, h1, h2, h3, h4, span, li, div, text, tspan').forEach((child) => {
        const cs = window.getComputedStyle(child as Element);
        if (cs.display === 'none' || cs.visibility === 'hidden') return;
        const t = child.textContent?.trim();
        if (t && t.length > 1) texts.push(t);
      });

      el.querySelectorAll('img').forEach((img) => {
        if (img.src && !img.src.startsWith('data:')) {
          images.push({ src: img.src, alt: img.alt || '' });
        }
      });

      return {
        triggerDescription: '',
        text: [...new Set(texts.filter((t) => t.length > 0))],
        images: images.filter((img, idx, arr) => arr.findIndex((i) => i.src === img.src) === idx),
      };
    }
    return null;
  });
}

async function dismissPopup(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  if (!(await isModalOpen(page))) return;

  // Escape didn't close it — try explicit close buttons inside the modal
  const dismissSelectors = [
    '.ReactModal__Content button',
    '[class*="close"]',
    '[aria-label*="close" i]',
    '[aria-label*="cerrar" i]',
    '[class*="modal-close"]',
    '[class*="popup-close"]',
    'button[class*="dismiss"]',
  ];

  for (const sel of dismissSelectors) {
    const btn = page.locator(sel).first();
    const visible = await btn.isVisible({ timeout: 300 }).catch(() => false);
    if (visible) {
      await btn.click();
      await page.waitForTimeout(400);
      return;
    }
  }
}

async function navigateBack(page: Page): Promise<void> {
  const prevBtn = page
    .locator('[aria-label*="previous" i], [aria-label*="anterior" i], [aria-label*="Go to the prev" i]')
    .first();
  const visible = await prevBtn.isVisible({ timeout: 300 }).catch(() => false);
  if (visible) {
    await prevBtn.click();
  } else {
    await page.keyboard.press('ArrowLeft');
  }
  await page.waitForTimeout(800);
}

export async function clickAndCapturePopups(page: Page): Promise<PopupContent[]> {
  const targets = await findClickTargets(page);
  log.info(`Found ${targets.length} interactive targets`);

  const popups: PopupContent[] = [];

  for (const target of targets) {
    const cx = target.x + target.width / 2;
    const cy = target.y + target.height / 2;

    try {
      const fpBefore = await getSlideTextFingerprint(page);

      await page.mouse.click(cx, cy);
      await page.waitForTimeout(700); // allow modal animations to complete

      const fpAfter = await getSlideTextFingerprint(page);
      const modalNowOpen = await isModalOpen(page);

      if (fpAfter !== fpBefore && !modalNowOpen) {
        // Fingerprint changed without a modal appearing → navigation click
        log.info(`Click on "${target.description}" triggered navigation, restoring`);
        await navigateBack(page);
        continue;
      }

      // Capture whatever opened (modal or other overlay)
      const popup = await captureOpenPopup(page);
      if (popup && (popup.text.length > 0 || popup.images.length > 0)) {
        popups.push({ ...popup, triggerDescription: target.description });
      }

      // Always dismiss — even if capture found nothing, the modal must be closed
      // so it doesn't block subsequent navigation
      if (modalNowOpen || fpAfter !== fpBefore) {
        await dismissPopup(page);
        await page.waitForTimeout(300);
      }
    } catch (err) {
      log.warn(`Failed to interact with "${target.description}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return popups;
}
