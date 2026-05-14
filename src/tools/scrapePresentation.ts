import { z } from 'zod';
import { scrapePresentation } from '../scraper/scrape.js';
import { log } from '../utils/logger.js';

export const inputSchema = z.object({
  url: z
    .string()
    .url()
    .describe('URL of the Genially presentation (e.g. https://view.genially.com/abc123)'),
  timeout_ms: z
    .number()
    .int()
    .min(5000)
    .max(300000)
    .optional()
    .describe('Timeout in milliseconds per operation (default: 30000)'),
  click_interactive: z
    .boolean()
    .optional()
    .describe('Whether to click interactive elements to reveal popup content (default: true)'),
  headless: z
    .boolean()
    .optional()
    .describe('Run browser in headless mode (default: true)'),
});

export type ScrapePresentationInput = z.infer<typeof inputSchema>;

export const TOOL_DEFINITION = {
  name: 'scrape-presentation',
  description:
    'Scrapes a Genially presentation and returns a complete transcript of all slides. ' +
    'Navigates through every slide and clicks interactive elements (hotspots, buttons, popups) ' +
    'to reveal hidden popup content. Returns text, images, and popup content per slide.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      url: {
        type: 'string',
        description: 'URL of the Genially presentation (e.g. https://view.genially.com/abc123)',
      },
      timeout_ms: {
        type: 'number',
        description: 'Timeout in milliseconds per operation (default: 30000, max: 300000)',
      },
      click_interactive: {
        type: 'boolean',
        description: 'Whether to click interactive elements to reveal popup content (default: true)',
      },
      headless: {
        type: 'boolean',
        description: 'Run browser in headless mode (default: true)',
      },
    },
    required: ['url'],
    additionalProperties: false,
  },
};

export async function handleTool(
  args: unknown,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const parsed = inputSchema.safeParse(args);

  if (!parsed.success) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: 'Invalid input', details: parsed.error.flatten() }),
        },
      ],
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
    };
  }
}
