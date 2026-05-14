import { chromium, Browser, BrowserContext, Page } from 'playwright';

export async function launchBrowser(headless = true): Promise<Browser> {
  return chromium.launch({
    headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });
}

export async function createPage(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    javaScriptEnabled: true,
    ignoreHTTPSErrors: true,
  });
  await context.route('**/*.{mp4,webm,ogg,avi,mov}', (route) => route.abort());
  const page = await context.newPage();
  return { context, page };
}
