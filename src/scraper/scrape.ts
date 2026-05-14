import { launchBrowser, createPage } from './browser.js';
import { waitForPresentation, getSlideCount, navigateToNextSlide, navigateToSlideByIndex, getSlideTextFingerprint } from './navigator.js';
import { extractSlideData, tryExtractFromInitialData } from './extractor.js';
import { clickAndCapturePopups } from './interactions.js';
import { ScrapeOptions, PresentationTranscript, SlideContent } from './types.js';
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
          const popups = await clickAndCapturePopups(page);
          slides[i].popups = popups;
          if (popups.length > 0) log.info(`Slide ${i + 1}: captured ${popups.length} popups`);

          if (i < slides.length - 1) {
            await navigateToNextSlide(page);
            const fp = await getSlideTextFingerprint(page);
            if (fp === firstFingerprint && i > 0) {
              log.info(`Navigation looped at slide ${i + 1}, stopping popup collection`);
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
    const visitedFingerprints = new Set<string>();
    let previousFingerprint = '';
    const MAX_SLIDES = 200;

    for (let slideIndex = 0; slideIndex < MAX_SLIDES; slideIndex++) {
      const currentFingerprint = await getSlideTextFingerprint(page);

      if (slideIndex > 0 && currentFingerprint === previousFingerprint) {
        log.info(`Slide ${slideIndex + 1}: content unchanged after navigation, stopping`);
        break;
      }

      if (slideIndex > 0 && visitedFingerprints.has(currentFingerprint)) {
        if (slideCount > slides.length) {
          log.info(`Loop at slide ${slideIndex + 1} but ${slideCount} total expected — jumping to dot ${slides.length}`);
          await navigateToSlideByIndex(page, slides.length);
          await page.waitForTimeout(1500);
          const afterJump = await getSlideTextFingerprint(page);
          if (!visitedFingerprints.has(afterJump) && afterJump !== previousFingerprint) {
            previousFingerprint = afterJump;
            continue;
          }
        }
        log.info('Detected loop (revisiting a previously seen slide), stopping');
        break;
      }

      visitedFingerprints.add(currentFingerprint);
      previousFingerprint = currentFingerprint;
      log.info(`Processing slide ${slideIndex + 1}`);

      const { text, images, title: slideTitle } = await extractSlideData(page);

      const popups =
        options.clickInteractive !== false
          ? await clickAndCapturePopups(page)
          : [];

      slides.push({
        slideIndex,
        slideTitle,
        text,
        images,
        popups,
      });

      const slideCountMatch = text.join(' ').match(/\b\d+\s*(?:of|de|\/)\s*(\d+)\b/i);
      if (slideCountMatch) {
        const detected = parseInt(slideCountMatch[1], 10);
        if (detected > slideCount) {
          slideCount = detected;
          log.info(`Updated slide count to ${slideCount} from slide text`);
        }
      }

      if (slideCount > 1 && slides.length >= slideCount) {
        log.info(`Reached expected slide count (${slideCount}), stopping`);
        break;
      }

      await navigateToNextSlide(page);
    }

    await context.close();

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
