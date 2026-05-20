# genially-mcp

An MCP server that scrapes content from Genially presentations using a headless browser.

## Tool: `scrape-presentation`

Navigates a Genially presentation URL, iterates through all slides, and returns a structured transcript of the content found.

### Input

| Parameter | Type | Required | Description |
|---|---|---|---|
| `url` | string | yes | Genially presentation URL (e.g. `https://view.genially.com/abc123`) |
| `timeout_ms` | number | no | Timeout per operation in ms (default: 30000, max: 300000) |
| `click_interactive` | boolean | no | Capture hidden/emergent content (default: true) |
| `headless` | boolean | no | Run browser in headless mode (default: true) |

### Output

```json
{
  "url": "https://view.genially.com/abc123",
  "title": "Presentation Title",
  "totalSlides": 5,
  "scrapedAt": "2026-05-14T12:00:00.000Z",
  "slides": [
    {
      "slideIndex": 0,
      "slideTitle": "Introduction",
      "text": ["Main title", "Subtitle text"],
      "images": [{ "src": "https://cdn.genially.com/...", "alt": "" }],
      "popups": [
        {
          "triggerDescription": "revealed content",
          "text": ["Hidden content text"],
          "images": []
        }
      ]
    }
  ]
}
```

## What it can do

- Extract all visible text from every slide, including text inside SVG elements.
- Capture interactive/emergent content (popups, tooltips, timeline items, hotspots) that is pre-rendered in the DOM but hidden until the user interacts with it.
- Navigate presentations automatically, detecting the total number of slides from page counters ("X of N") or navigation dots.
- Return image URLs (with alt text where available) for every `<img>` element and CSS background image on each slide.
- Handle presentations with up to 200 slides.

## What it cannot do

- **Read text embedded in images.** If a slide contains a photograph or diagram where the text is part of the image itself, that text is not extracted. Only the image URL is returned.
- **Capture content that requires account login.** Presentations behind a Genially login wall are not accessible.
- **Guarantee complete coverage of every interactive pattern.** The tool reads hidden content that Genially pre-renders in the DOM. Content that is loaded dynamically after a click (via a network request) may not be captured.
- **Preserve layout or visual structure.** The output is a flat list of text strings per slide. Reading order may not match the visual order on screen, especially for complex multi-column or layered layouts.
- **Extract audio or video content.** Only text and image URLs are returned.
- **Return semantic slide titles reliably.** The `slideTitle` field is inferred from the first heading-like element found. For slides without a clear heading, it may default to the page counter text (e.g. "Page 3 of 26").

## Setup

```bash
npm install
npm run install:browsers   # installs Playwright Chromium
npm run build
```

## Claude Desktop configuration

```json
{
  "mcpServers": {
    "genially-scraper": {
      "command": "node",
      "args": ["/path/to/genially-mcp/dist/index.js"]
    }
  }
}
```
