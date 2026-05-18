import { launchBrowser, createPage } from './browser.js';
import { waitForPresentation, getSlideCount, navigateToNextSlide, getSlideTextFingerprint, getPageInfo } from './navigator.js';
import { extractSlideData, tryExtractFromInitialData, extractHiddenContent } from './extractor.js';
import { ScrapeOptions, PresentationTranscript, SlideContent, SlideImage, PopupContent } from './types.js';
import { log } from '../utils/logger.js';

export async function scrapePresentation(options: ScrapeOptions): Promise<PresentationTranscript> {
  const timeoutMs = options.timeoutMs ?? 30000;
  const browser = await launchBrowser(options.headless ?? true);

  try {
    const { context, page } = await createPage(browser);

    log.info(`Navigating to ${options.url}`);
    await page.goto(options.url, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });

    await waitForPresentation(page, timeoutMs);

    const pageTitle = await page.title();

    // --- Phase 1: Try INITIAL_DATA for fast, complete text extraction ---
    const initialDataSlides = await tryExtractFromInitialData(page);

    if (initialDataSlides && initialDataSlides.length > 0) {
      log.info(`INITIAL_DATA: extracted ${initialDataSlides.length} slides, page title: "${pageTitle}"`);

      const slides: SlideContent[] = initialDataSlides.map((s) => ({
        slideIndex: s.slideIndex,
        slideTitle: s.text[0] ?? null,
        text: s.text,
        images: s.images,
        popups: [],
      }));

      // --- Phase 2: Navigate through slides to capture popup content ---
      if (options.clickInteractive !== false) {
        const firstFingerprint = await getSlideTextFingerprint(page);

        for (let i = 0; i < slides.length; i++) {
          const popups = await extractHiddenContent(page).catch(() => []);
          slides[i].popups = popups;
          if (popups.length > 0) log.info(`Slide ${i + 1}: captured ${popups.length} hidden/emergent blocks`);

          if (i < slides.length - 1) {
            await navigateToNextSlide(page);
            const fp = await getSlideTextFingerprint(page);
            if (fp === firstFingerprint && i > 0) {
              log.info(`Navigation looped at slide ${i + 1}, stopping`);
              break;
            }
          }
        }
      }

      await context.close();
      return {
        url: options.url,
        title: pageTitle || null,
        totalSlides: slides.length,
        scrapedAt: new Date().toISOString(),
        slides,
      };
    }

    // --- Phase 3: Fall back to full navigation-based extraction ---
    log.info(`INITIAL_DATA not available — falling back to navigation. Page title: "${pageTitle}"`);

    let slideCount = await getSlideCount(page);
    log.info(`Detected ${slideCount} slides`);

    const slides: SlideContent[] = [];
    let previousFingerprint = '';
    let firstFingerprint = '';
    let maxPageSeen = 0;
    const MAX_SLIDES = 200;

    for (let slideIndex = 0; slideIndex < MAX_SLIDES; slideIndex++) {
      let currentFingerprint: string;
      try {
        currentFingerprint = await getSlideTextFingerprint(page);
      } catch (e) {
        log.warn(`Could not read slide ${slideIndex + 1}, stopping with ${slides.length} slides: ${e}`);
        break;
      }
      if (slideIndex === 0) firstFingerprint = currentFingerprint;

      // No progress: navigation didn't change the slide content
      if (slideIndex > 0 && currentFingerprint === previousFingerprint) {
        log.info(`Slide ${slideIndex + 1}: content unchanged after navigation, stopping`);
        break;
      }

      const { current, total } = await getPageInfo(page).catch(() => ({ current: null, total: null }));

      if (current != null && total != null) {
        // Page counter is the reliable termination signal
        if (total > slideCount) slideCount = total;
        if (slideIndex > 0 && current <= maxPageSeen) {
          log.info(`Page counter went ${current}/${total} (max seen ${maxPageSeen}) — wrapped around, stopping`);
          break;
        }
        maxPageSeen = Math.max(maxPageSeen, current);
      } else if (slideIndex > 0 && currentFingerprint === firstFingerprint) {
        // No counter available — fall back to true wrap-to-first detection
        log.info('Looped back to first slide (no page counter), stopping');
        break;
      }

      previousFingerprint = currentFingerprint;
      log.info(
        `Processing slide ${slideIndex + 1}${current != null ? ` (page ${current} of ${total})` : ''}`,
      );

      let text: string[] = [];
      let images: SlideImage[] = [];
      let slideTitle: string | null = null;
      try {
        ({ text, images, title: slideTitle } = await extractSlideData(page));
      } catch (e) {
        log.warn(`extractSlideData failed on slide ${slideIndex + 1}: ${e}`);
      }

      let popups: PopupContent[] = [];
      if (options.clickInteractive !== false) {
        try {
          popups = await extractHiddenContent(page);
        } catch (e) {
          log.warn(`extractHiddenContent failed on slide ${slideIndex + 1}: ${e}`);
        }
      }

      slides.push({ slideIndex, slideTitle, text, images, popups });

      const slideCountMatch = text.join(' ').match(/\b\d+\s*(?:of|de|\/)\s*(\d+)\b/i);
      if (slideCountMatch) {
        const detected = parseInt(slideCountMatch[1], 10);
        if (detected > slideCount) {
          slideCount = detected;
          log.info(`Updated slide count to ${slideCount} from slide text`);
        }
      }

      if (slideCount > 1 && slides.length >= slideCount) {
        log.info(`Collected all ${slideCount} slides, stopping`);
        break;
      }

      // A navigation failure must never discard slides already collected
      try {
        await navigateToNextSlide(page);
      } catch (e) {
        log.warn(`Navigation failed at slide ${slideIndex + 1}, returning ${slides.length} slides: ${e}`);
        break;
      }
    }

    await context.close().catch(() => {});

    return {
      url: options.url,
      title: pageTitle || null,
      totalSlides: slides.length,
      scrapedAt: new Date().toISOString(),
      slides,
    };
  } finally {
    await browser.close();
  }
}
