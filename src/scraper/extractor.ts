import { Page } from 'playwright';
import { SlideImage, PopupContent } from './types.js';

export interface ExtractedSlideData {
  text: string[];
  images: SlideImage[];
  title: string | null;
}

export interface InitialDataSlide {
  slideIndex: number;
  text: string[];
  images: SlideImage[];
}

export async function tryExtractFromInitialData(page: Page): Promise<InitialDataSlide[] | null> {
  return page.evaluate((): { slideIndex: number; text: string[]; images: { src: string; alt: string }[] }[] | null => {
    const w = window as any;
    const raw: unknown[] | undefined = w.INITIAL_DATA?.socialViewProps?.rawTranscriptions;
    if (!Array.isArray(raw) || raw.length === 0) return null;

    const h = window.__geniallyScraper;
    if (!h) throw new Error('genially-scraper page helpers are not installed');

    // DOMParser documents are inert: no image loads, no inline handlers run
    const parser = new DOMParser();

    return raw.map((item: unknown, idx: number) => {
      const html =
        typeof item === 'string'
          ? item
          : typeof (item as any)?.content === 'string'
            ? (item as any).content
            : '';
      if (!html) return { slideIndex: idx, text: [], images: [] };

      const doc = parser.parseFromString(html, 'text/html');
      const texts = [...new Set(h.collectLines(doc.body))];

      const images: { src: string; alt: string }[] = [];
      const imgSrcs = new Set<string>();
      doc.querySelectorAll('img').forEach((img) => {
        const src = img.getAttribute('src') ?? '';
        if (src && !src.startsWith('data:') && !imgSrcs.has(src)) {
          imgSrcs.add(src);
          images.push({ src, alt: img.getAttribute('alt') ?? '' });
        }
      });

      return { slideIndex: idx, text: texts, images };
    });
  });
}

export async function extractSlideData(page: Page): Promise<ExtractedSlideData> {
  await page.waitForTimeout(400);

  return page.evaluate((): { text: string[]; images: SlideImage[]; title: string | null } => {
    const h = window.__geniallyScraper;
    if (!h) throw new Error('genially-scraper page helpers are not installed');

    const texts: string[] = [];
    const images: SlideImage[] = [];

    const root = h.findActiveSlideRoot();

    // Walk visible elements extracting text
    function walkText(el: Element): void {
      const tag = el.tagName.toLowerCase();

      // Check tag name FIRST — <style> elements can have display:block when injected by
      // CSS-in-JS frameworks (styled-components, emotion) used by Genially's React app,
      // which would make them pass the visibility check below and leak raw CSS into text[]
      if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'head') return;

      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;

      // SVG text elements
      if (tag === 'text' || tag === 'tspan') {
        const t = el.textContent?.trim();
        if (t && t.length > 0) texts.push(t);
        return;
      }

      // Leaf text nodes or near-leaf elements (only inline children)
      const childNodes = Array.from(el.childNodes);
      const inlineTags = new Set(['span', 'strong', 'em', 'b', 'i', 'u', 'a', 'br', 'abbr', 'code', 'mark']);
      const isNearLeaf = childNodes.every(
        (c) =>
          c.nodeType === Node.TEXT_NODE ||
          inlineTags.has((c as Element).tagName?.toLowerCase() ?? ''),
      );

      if (isNearLeaf) {
        const t = el.textContent?.trim();
        if (t && t.length > 0) texts.push(t);
      } else {
        // Capture any direct text nodes (loose text in a non-leaf container)
        for (const child of childNodes) {
          if (child.nodeType === Node.TEXT_NODE) {
            const t = child.textContent?.trim();
            if (t && t.length > 0) texts.push(t);
          }
        }
        Array.from(el.children).forEach((child) => walkText(child));
      }
    }

    walkText(root);

    // Filter out CSS/animation code that Genially injects as visible text nodes.
    // These appear as raw CSS strings in <div> elements used for animation markup,
    // not inside <style> tags, so tag-based filtering can't catch them.
    const uniqueTexts = [...new Set(
      texts.filter((t) => t.length > 0 && !h.isCssLike(t))
    )];

    // Extract title from first heading-like element
    const headingEl = root.querySelector('h1, h2, h3, [class*="title"], [class*="heading"]');
    const title = headingEl?.textContent?.trim() ?? null;

    // Extract <img> elements
    root.querySelectorAll('img').forEach((img) => {
      const src = img.src || img.getAttribute('data-src') || '';
      if (src && !src.startsWith('data:') && src.length > 0) {
        images.push({ src, alt: img.alt || '' });
      }
    });

    // Extract CSS background images
    root.querySelectorAll<HTMLElement>('[style*="background-image"]').forEach((el) => {
      const match = el.style.backgroundImage.match(/url\(['"]?([^'")\s]+)['"]?\)/);
      if (match && match[1] && !match[1].startsWith('data:')) {
        images.push({ src: match[1], alt: el.getAttribute('aria-label') || '' });
      }
    });

    // Deduplicate images by src
    const uniqueImages = images.filter(
      (img, idx, arr) => arr.findIndex((i) => i.src === img.src) === idx,
    );

    return { text: uniqueTexts, images: uniqueImages, title };
  });
}

// Genially pre-renders interactive/popup content as `.genially-animated-wrapper`
// elements that are present in the DOM but visually hidden (opacity 0) until the
// user clicks a trigger. The text is therefore already available WITHOUT clicking
// anything — which avoids the modal-blocks-navigation problem entirely. This reads
// the currently-hidden wrappers (the emergent content) of the active slide; visible
// ones are left to extractSlideData so the base slide text isn't duplicated.
const HIDDEN_CANDIDATE_ATTR = 'data-genially-scraper-hidden';

export async function extractHiddenContent(page: Page): Promise<PopupContent[]> {
  const candidates = await page.evaluate((attr): number => {
    const h = window.__geniallyScraper;
    if (!h) throw new Error('genially-scraper page helpers are not installed');
    const CHROME =
      /genially-view-(icon|cursor-pointer|navigation|footer|header|background_audio|toolbar)|StickyBanner/;

    document.querySelectorAll(`[${attr}]`).forEach((el) => el.removeAttribute(attr));

    let count = 0;
    h.findActiveSlideRoot().querySelectorAll('.genially-animated-wrapper').forEach((w) => {
      const cls = w.className ? w.className.toString() : '';
      if (CHROME.test(cls)) return;

      // Emergent = the wrapper (or its content item) is currently hidden
      const inner = w.querySelector('.genially-view-text, .genially-view-item');
      if (h.isHidden(w) || (inner !== null && h.isHidden(inner))) {
        w.setAttribute(attr, '');
        count++;
      }
    });
    return count;
  }, HIDDEN_CANDIDATE_ATTR);

  if (candidates === 0) return [];

  // Entrance animations also start at opacity 0; only wrappers still hidden once
  // those have had time to play are emergent content
  await page.waitForTimeout(600);

  return page.evaluate((attr): { triggerDescription: string; text: string[]; images: SlideImage[] }[] => {
    const h = window.__geniallyScraper;
    if (!h) throw new Error('genially-scraper page helpers are not installed');

    const popups: { triggerDescription: string; text: string[]; images: SlideImage[] }[] = [];
    const seen = new Set<string>();

    document.querySelectorAll(`[${attr}]`).forEach((w) => {
      w.removeAttribute(attr);
      const inner = w.querySelector('.genially-view-text, .genially-view-item');
      if (!h.isHidden(w) && !(inner !== null && h.isHidden(inner))) return;

      // collectLines skips <script>/<style>, so styled-components CSS doesn't leak in;
      // the CSS filter then runs per line, so one stray rule can't drop the popup
      const lines = [...new Set(h.collectLines(w).filter((s) => s.length > 1 && !h.isCssLike(s)))];
      if (lines.length === 0) return;

      const key = lines.join('|');
      if (seen.has(key)) return;
      seen.add(key);

      const images: SlideImage[] = [];
      w.querySelectorAll('img').forEach((img) => {
        const src = img.getAttribute('src') ?? '';
        if (src && !src.startsWith('data:')) images.push({ src, alt: (img as HTMLImageElement).alt || '' });
      });

      popups.push({
        triggerDescription: w.getAttribute('data-noddus-item-name') || 'revealed content',
        text: lines,
        images: images.filter((img, i, arr) => arr.findIndex((x) => x.src === img.src) === i),
      });
    });

    return popups;
  }, HIDDEN_CANDIDATE_ATTR);
}
