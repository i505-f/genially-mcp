import { z } from 'zod';
import { scrapePresentation, isGeniallyUrl } from '../scraper/scrape.js';
import { DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS } from '../scraper/types.js';
import { log } from '../utils/logger.js';

const DESCRIPTIONS = {
  url: 'URL of the Genially presentation (e.g. https://view.genially.com/abc123). Only genially.com URLs are accepted.',
  timeout_ms: `Timeout in milliseconds per operation (default: ${DEFAULT_TIMEOUT_MS}, min: ${MIN_TIMEOUT_MS}, max: ${MAX_TIMEOUT_MS})`,
  click_interactive: 'Whether to capture hidden/emergent popup content (default: true)',
  headless: 'Run browser in headless mode (default: true)',
};

export const inputSchema = z.object({
  url: z
    .string()
    .url()
    .refine(isGeniallyUrl, { message: 'URL must be an http(s) genially.com address' })
    .describe(DESCRIPTIONS.url),
  timeout_ms: z
    .number()
    .int()
    .min(MIN_TIMEOUT_MS)
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe(DESCRIPTIONS.timeout_ms),
  click_interactive: z.boolean().optional().describe(DESCRIPTIONS.click_interactive),
  headless: z.boolean().optional().describe(DESCRIPTIONS.headless),
});

export type ScrapePresentationInput = z.infer<typeof inputSchema>;

export const TOOL_DEFINITION = {
  name: 'scrape-presentation',
  description:
    'Scrapes a Genially presentation and returns a complete transcript of all slides. ' +
    'Navigates through every slide and reads interactive content (hotspots, buttons, popups) ' +
    'that Genially pre-renders hidden in the page. Returns text, images, and popup content per slide.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      url: { type: 'string', format: 'uri', description: DESCRIPTIONS.url },
      timeout_ms: {
        type: 'integer',
        minimum: MIN_TIMEOUT_MS,
        maximum: MAX_TIMEOUT_MS,
        description: DESCRIPTIONS.timeout_ms,
      },
      click_interactive: { type: 'boolean', description: DESCRIPTIONS.click_interactive },
      headless: { type: 'boolean', description: DESCRIPTIONS.headless },
    },
    required: ['url'],
    additionalProperties: false,
  },
};

export async function handleTool(
  args: unknown,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const parsed = inputSchema.safeParse(args);

  if (!parsed.success) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: 'Invalid input', details: parsed.error.flatten() }),
        },
      ],
      isError: true,
    };
  }

  const { url, timeout_ms, click_interactive, headless } = parsed.data;
  log.info(`Tool called: scrape-presentation url=${url}`);

  try {
    const transcript = await scrapePresentation({
      url,
      timeoutMs: timeout_ms,
      clickInteractive: click_interactive,
      headless,
    });

    return {
      content: [{ type: 'text', text: JSON.stringify(transcript, null, 2) }],
    };
  } catch (err) {
    log.error('scrape-presentation failed', err);
    const message = err instanceof Error ? err.message : String(err);
    const isAuth =
      message.toLowerCase().includes('login') ||
      message.toLowerCase().includes('private') ||
      message.toLowerCase().includes('auth');

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: isAuth
              ? 'This presentation may be private or require authentication'
              : 'Failed to scrape presentation',
            details: message,
          }),
        },
      ],
      isError: true,
    };
  }
}
