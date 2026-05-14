import { launchBrowser, createPage } from './browser.js';
import { waitForPresentation, getSlideCount, getCurrentSlideIndex, navigateToNextSlide, getSlideTextFingerprint } from './navigator.js';
import { extractSlideData } from './extractor.js';
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
    const slideCount = await getSlideCount(page);
    log.info(`Detected ${slideCount} slides, page title: "${pageTitle}"`);

    const slides: SlideContent[] = [];
    let stuckCount = 0;
    const firstFingerprint = await getSlideTextFingerprint(page);
    let previousFingerprint = firstFingerprint;
    const MAX_SLIDES = 200;

    for (let slideIndex = 0; slideIndex < MAX_SLIDES; slideIndex++) {
      const currentFingerprint = await getSlideTextFingerprint(page);

      // Detect loop back to first slide (navigation wrapped around)
      if (slideIndex > 0 && currentFingerprint === firstFingerprint) {
        log.info('Detected loop back to first slide, stopping');
        break;
      }

      // Detect no progress: same content as the previous slide twice in a row
      if (slideIndex > 0 && currentFingerprint === previousFingerprint) {
        stuckCount++;
        if (stuckCount >= 2) {
          log.info('No more slides to navigate, stopping');
          break;
        }
      } else {
        stuckCount = 0;
      }

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

      // Stop if we know the total and we've reached it
      if (slideCount > 1 && slides.length >= slideCount) {
        log.info(`Reached expected slide count (${slideCount}), stopping`);
        break;
      }

      await navigateToNextSlide(page);

      // Re-check index for single-slide decks
      const currentIdx = await getCurrentSlideIndex(page);
      if (currentIdx === 0 && slideIndex > 0) {
        log.info('Navigation wrapped around to slide 0, stopping');
        break;
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
  } finally {
    await browser.close();
  }
}
