import { Page } from 'playwright';
import { PopupContent, SlideImage } from './types.js';
import { log } from '../utils/logger.js';
import { getSlideTextFingerprint, isModalOpen, dismissAnyModal } from './navigator.js';

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
      '.ReactModal__Overlay',
    ];

    for (const sel of popupSelectors) {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) continue;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

      // innerText respects rendering/visibility and handles Genially's obfuscated nested
      // DOM far better than per-tag traversal (which missed most popup content)
      const raw = el.innerText ?? '';
      const text = [
        ...new Set(
          raw
            .split('\n')
            .map((s) => s.trim())
            .filter((s) => s.length > 1),
        ),
      ];

      const images: SlideImage[] = [];
      el.querySelectorAll('img').forEach((img) => {
        if (img.src && !img.src.startsWith('data:')) {
          images.push({ src: img.src, alt: img.alt || '' });
        }
      });
      const uniqueImages = images.filter(
        (img, idx, arr) => arr.findIndex((i) => i.src === img.src) === idx,
      );

      if (text.length === 0 && uniqueImages.length === 0) continue;
      return { triggerDescription: '', text, images: uniqueImages };
    }
    return null;
  });
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
        await dismissAnyModal(page);
        await page.waitForTimeout(300);
        // If a stray navigation also happened, undo it so the slide index stays aligned
        if ((await getSlideTextFingerprint(page)) !== fpBefore && !(await isModalOpen(page))) {
          await navigateBack(page);
        }
      }
    } catch (err) {
      log.warn(`Failed to interact with "${target.description}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return popups;
}
