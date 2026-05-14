import { Page } from 'playwright';
import { PopupContent, SlideImage } from './types.js';
import { log } from '../utils/logger.js';

interface ClickTarget {
  description: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export async function findClickTargets(page: Page): Promise<ClickTarget[]> {
  return page.evaluate((): ClickTarget[] => {
    const targets: ClickTarget[] = [];
    const seen = new Set<Element>();

    // Specific Genially interactive element selectors
    const interactiveSelectors = [
      '[class*="hotspot"]',
      '[class*="hot-spot"]',
      '[data-animation]',
      '[data-genially-type="button"]',
      '[data-genially-type="hotspot"]',
      '[class*="tooltip-trigger"]',
      '[class*="popup-trigger"]',
      '[class*="interactive"]',
      '[class*="genially-view-hotspot"]',
      '[class*="pulse"]',
      '[class*="ping"]',
    ];

    for (const sel of interactiveSelectors) {
      document.querySelectorAll(sel).forEach((el) => {
        if (seen.has(el)) return;
        seen.add(el);
        const rect = el.getBoundingClientRect();
        if (rect.width < 5 || rect.height < 5) return;
        const desc =
          el.getAttribute('aria-label') ||
          el.getAttribute('title') ||
          el.textContent?.trim().slice(0, 60) ||
          el.className.toString().slice(0, 50) ||
          'interactive element';
        targets.push({ description: desc, x: rect.x, y: rect.y, width: rect.width, height: rect.height });
      });
    }

    // Also collect cursor:pointer elements that are not navigation
    document.querySelectorAll('*').forEach((el) => {
      if (seen.has(el)) return;
      const style = window.getComputedStyle(el);
      if (
        style.cursor !== 'pointer' ||
        style.display === 'none' ||
        style.visibility === 'hidden'
      ) return;
      if (
        el.closest('[class*="navigation"]') ||
        el.closest('[class*="nav-bar"]') ||
        el.closest('[class*="arrow"]') ||
        el.closest('[class*="next"]') ||
        el.closest('[class*="prev"]') ||
        el.matches('a[href*="//"]') ||
        el.tagName === 'HTML' ||
        el.tagName === 'BODY'
      ) return;

      const rect = el.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) return;

      seen.add(el);
      const desc =
        el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        el.textContent?.trim().slice(0, 60) ||
        'clickable area';
      targets.push({ description: desc, x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    });

    return targets;
  });
}

async function captureOpenPopup(page: Page): Promise<PopupContent | null> {
  return page.evaluate((): { triggerDescription: string; text: string[]; images: SlideImage[] } | null => {
    const popupSelectors = [
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
  const dismissSelectors = [
    '[class*="close"]',
    '[aria-label*="close" i]',
    '[aria-label*="cerrar" i]',
    '[class*="modal-close"]',
    '[class*="popup-close"]',
    'button[class*="dismiss"]',
  ];

  for (const sel of dismissSelectors) {
    const btn = page.locator(sel).first();
    const visible = await btn.isVisible({ timeout: 400 }).catch(() => false);
    if (visible) {
      await btn.click();
      await page.waitForTimeout(400);
      return;
    }
  }

  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
}

export async function clickAndCapturePopups(page: Page): Promise<PopupContent[]> {
  const targets = await findClickTargets(page);
  log.info(`Found ${targets.length} interactive targets`);

  const popups: PopupContent[] = [];

  for (const target of targets) {
    const cx = target.x + target.width / 2;
    const cy = target.y + target.height / 2;

    try {
      await page.mouse.click(cx, cy);
      await page.waitForTimeout(700);

      const popup = await captureOpenPopup(page);
      if (popup && (popup.text.length > 0 || popup.images.length > 0)) {
        popups.push({ ...popup, triggerDescription: target.description });
        await dismissPopup(page);
        await page.waitForTimeout(400);
      }
    } catch (err) {
      log.warn(`Failed to interact with "${target.description}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return popups;
}
