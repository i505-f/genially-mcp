import { BrowserContext } from 'playwright';

export interface PageHelpers {
  isCssLike(text: string): boolean;
  isHidden(el: Element): boolean;
  collectLines(root: Element): string[];
  findActiveSlideRoot(): Element;
}

declare global {
  interface Window {
    __geniallyScraper?: PageHelpers;
  }
}

// page.evaluate callbacks are serialized into the page and cannot reference
// module-level functions, so helpers shared by several extractors are installed
// once per document here and read back from window.__geniallyScraper.
export async function installPageHelpers(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    // Raw CSS that Genially injects as text (styled-components, animation markup).
    // Only structural CSS markers count: at-rules, selector or declaration blocks,
    // and lines made entirely of `prop: value;` declarations. A single "word:"
    // ("Energy transition: key challenges") is ordinary prose.
    const CSS_LIKE =
      /@(?:keyframes|media|font-face|supports|import)\b|[.#][\w-]+\s*\{|\{[^{}]*:[^{}]*\}|^\s*(?:-?[a-z][a-z-]*\s*:[^;{}]+;\s*)+-?[a-z][a-z-]*\s*:[^;{}]+;?\s*$/;

    const INLINE = new Set([
      'span', 'strong', 'em', 'b', 'i', 'u', 'a', 'br', 'abbr', 'code', 'mark', 'sub', 'sup', 'small', 's', 'font', 'label',
    ]);
    const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head']);

    function isInlineNode(node: Node): boolean {
      if (node.nodeType !== Node.ELEMENT_NODE) return true;
      return INLINE.has((node as Element).tagName.toLowerCase());
    }

    function inlineText(node: Node): string {
      // Source newlines are formatting; only <br> marks a real line break
      if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').replace(/\s+/g, ' ');
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      const tag = (node as Element).tagName.toLowerCase();
      if (tag === 'br') return '\n';
      if (SKIP.has(tag)) return '';
      return Array.from(node.childNodes).map(inlineText).join('');
    }

    // Block-aware text walk: each run of inline content becomes its own entry,
    // <br> splits lines, and loose text beside block children is kept. Works on
    // detached and DOMParser documents, where layout-based innerText is unavailable.
    function collectLines(root: Element): string[] {
      const out: string[] = [];
      const push = (text: string): void => {
        for (const line of text.split('\n')) {
          const t = line.trim();
          if (t.length > 0) out.push(t);
        }
      };
      const walk = (el: Element): void => {
        if (SKIP.has(el.tagName.toLowerCase())) return;
        let run = '';
        for (const child of Array.from(el.childNodes)) {
          if (isInlineNode(child)) {
            run += inlineText(child);
          } else {
            push(run);
            run = '';
            walk(child as Element);
          }
        }
        push(run);
      };
      walk(root);
      return out;
    }

    function isHidden(el: Element): boolean {
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
    }

    function findActiveSlideRoot(): Element {
      const candidates = [
        ...Array.from(document.querySelectorAll('[class*="genially-slide"][class*="active"]')),
        ...Array.from(document.querySelectorAll('section[class*="active"]')),
        ...Array.from(document.querySelectorAll('[data-genially-slide-index]')).filter((el) => {
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden';
        }),
      ];
      return candidates[0] ?? document.body;
    }

    window.__geniallyScraper = {
      isCssLike: (text: string) => CSS_LIKE.test(text),
      isHidden,
      collectLines,
      findActiveSlideRoot,
    };
  });
}
