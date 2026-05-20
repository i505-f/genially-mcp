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

    return raw.map((item: unknown, idx: number) => {
      const html =
        typeof item === 'string'
          ? item
          : typeof (item as any)?.content === 'string'
            ? (item as any).content
            : '';
      if (!html) return { slideIndex: idx, text: [], images: [] };

      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      tmp.querySelectorAll('script, style').forEach((el) => el.remove());

      const texts: string[] = [];
      const seen = new Set<string>();
      const inlineTags = new Set(['span', 'strong', 'em', 'b', 'i', 'u', 'a', 'br', 'abbr', 'code', 'mark', 'sub', 'sup']);

      function walkNodes(el: Element): void {
        const hasBlockChild = Array.from(el.children).some(
          (c) => !inlineTags.has(c.tagName.toLowerCase()),
        );
        if (!hasBlockChild) {
          const t = el.textContent?.trim() ?? '';
          if (t.length > 0 && !seen.has(t)) {
            seen.add(t);
            texts.push(t);
          }
        } else {
          Array.from(el.children).forEach((c) => walkNodes(c));
        }
      }

      walkNodes(tmp);

      const images: { src: string; alt: string }[] = [];
      const imgSrcs = new Set<string>();
      tmp.querySelectorAll('img').forEach((img) => {
        const src = img.getAttribute('src') ?? '';
        if (src && !src.startsWith('data:') && !imgSrcs.has(src)) {
          imgSrcs.add(src);
          images.push({ src, alt: (img as HTMLImageElement).alt ?? '' });
        }
      });

      return { slideIndex: idx, text: texts, images };
    });
  });
}

export async function extractSlideData(page: Page): Promise<ExtractedSlideData> {
  await page.waitForTimeout(400);

  return page.evaluate((): { text: string[]; images: SlideImage[]; title: string | null } => {
    const texts: string[] = [];
    const images: SlideImage[] = [];

    // Find active slide container
    const candidateContainers = [
      ...Array.from(document.querySelectorAll('[class*="genially-slide"][class*="active"]')),
      ...Array.from(document.querySelectorAll('section[class*="active"]')),
      ...Array.from(document.querySelectorAll('[data-genially-slide-index]')).filter((el) => {
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden';
      }),
    ];

    const root: Element = candidateContainers[0] ?? document.body;

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
    const CSS_PATTERN = /(?:@keyframes\s|@media\s|\.[\w-]+\s*\{|\w+\s*:\s*\w+[^;]*;[\s\S]*?\}|:hover\s*\{|:focus\s*\{|animation\s*:|transition\s*:|transform\s*:)/;
    const uniqueTexts = [...new Set(
      texts.filter((t) => t.length > 0 && !CSS_PATTERN.test(t))
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
// the currently-hidden wrappers (the emergent content); visible ones are left to
// extractSlideData so the base slide text isn't duplicated.
export async function extractHiddenContent(page: Page): Promise<PopupContent[]> {
  return page.evaluate((): { triggerDescription: string; text: string[]; images: SlideImage[] }[] => {
    const CHROME =
      /genially-view-(icon|cursor-pointer|navigation|footer|header|background_audio|toolbar)|StickyBanner/;

    const isHidden = (el: Element): boolean => {
      const cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return true;
      if (parseFloat(cs.opacity || '1') <= 0.05) return true;
      const m = cs.transform.match(/matrix\(([^)]+)\)/);
      if (m) {
        const parts = m[1].split(',').map((n) => parseFloat(n));
        // matrix(a,b,c,d,e,f): scaleX≈a, scaleY≈d — scaled to ~0 means hidden
        if (Math.abs(parts[0]) < 0.05 && Math.abs(parts[3]) < 0.05) return true;
      }
      return false;
    };

    // Same filter extractSlideData uses: styled-components inject <style> blocks
    // inside these wrappers, and textContent would otherwise leak raw CSS.
    const CSS_PATTERN =
      /(?:@keyframes\s|@media\s|\.[\w-]+\s*\{|\w+\s*:\s*\w+[^;]*;[\s\S]*?\}|:hover\s*\{|:focus\s*\{|animation\s*:|transition\s*:|transform\s*:)/;

    const popups: { triggerDescription: string; text: string[]; images: SlideImage[] }[] = [];
    const seen = new Set<string>();

    document.querySelectorAll('.genially-animated-wrapper').forEach((w) => {
      const cls = w.className ? w.className.toString() : '';
      if (CHROME.test(cls)) return;

      // Emergent = the wrapper (or its content item) is currently hidden
      const inner = w.querySelector('.genially-view-text, .genially-view-item');
      const hidden = isHidden(w) || (inner !== null && isHidden(inner));
      if (!hidden) return;

      // Clone and strip <script>/<style> so styled-components CSS doesn't leak in
      const clone = w.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('script, style').forEach((el) => el.remove());
      const raw = clone.textContent ?? '';
      const lines = [
        ...new Set(
          raw
            .split('\n')
            .map((s) => s.trim())
            .filter((s) => s.length > 1 && !CSS_PATTERN.test(s)),
        ),
      ];
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
  });
}
