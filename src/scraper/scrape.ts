import { launchBrowser, createPage } from './browser.js';
import { waitForPresentation, getSlideCount, navigateToNextSlide, navigateToSlideByIndex, getSlideTextFingerprint } from './navigator.js';
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
    let slideCount = await getSlideCount(page);
    log.info(`Detected ${slideCount} slides, page title: "${pageTitle}"`);

    const slides: SlideContent[] = [];
    const firstFingerprint = await getSlideTextFingerprint(page);
    let previousFingerprint = firstFingerprint;
    const MAX_SLIDES = 200;

    for (let slideIndex = 0; slideIndex < MAX_SLIDES; slideIndex++) {
      const currentFingerprint = await getSlideTextFingerprint(page);

      // Detect no progress: content unchanged since last navigation
      if (slideIndex > 0 && currentFingerprint === previousFingerprint) {
        log.info(`Slide ${slideIndex + 1}: content unchanged after navigation, stopping`);
        break;
      }

      // Detect loop back to first slide (linear section ended, navigation wrapped around)
      if (slideIndex > 0 && currentFingerprint === firstFingerprint) {
        // If we know more slides exist (detected via "X of Y" text or dot count),
        // attempt to jump to the next unvisited slide via dot navigation
        if (slideCount > slides.length) {
          log.info(`Loop at slide ${slideIndex + 1} but ${slideCount} total expected — jumping to dot ${slides.length}`);
          await navigateToSlideByIndex(page, slides.length);
          await page.waitForTimeout(1500);
          const afterJump = await getSlideTextFingerprint(page);
          if (afterJump !== firstFingerprint && afterJump !== previousFingerprint) {
            previousFingerprint = afterJump;
            continue;
          }
        }
        log.info('Detected loop back to first slide, stopping');
        break;
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

      // Update slideCount if slide text reveals "X of N" (e.g. "Page 3 of 26").
      // getSlideCount() runs on the cover page which often has no counter, so we
      // update dynamically as we scrape slides that do show the counter.
      const slideCountMatch = text.join(' ').match(/\b\d+\s*(?:of|de|\/)\s*(\d+)\b/i);
      if (slideCountMatch) {
        const detected = parseInt(slideCountMatch[1], 10);
        if (detected > slideCount) {
          slideCount = detected;
          log.info(`Updated slide count to ${slideCount} from slide text`);
        }
      }

      // Stop if we know the total and we've reached it
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
