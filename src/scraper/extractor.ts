import { Page } from 'playwright';
import { SlideImage } from './types.js';

export interface ExtractedSlideData {
  text: string[];
  images: SlideImage[];
  title: string | null;
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

    // Deduplicate and filter empty strings, remove very long duplicated substrings
    const uniqueTexts = [...new Set(texts.filter((t) => t.length > 0))];

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
