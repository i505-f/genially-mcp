# genially-mcp

An MCP server that allows scraping all content in Genially presentations.

## Tool: `scrape-presentation`

Navigates a Genially presentation URL, iterates through all slides, and returns a complete transcript including:

- All visible text on each slide (including SVG text)
- Image URLs per slide
- Content from interactive elements (hotspots, popups, tooltips) that only appear when clicked

### Input

| Parameter | Type | Required | Description |
|---|---|---|---|
| `url` | string | yes | Genially presentation URL (e.g. `https://view.genially.com/abc123`) |
| `timeout_ms` | number | no | Timeout per operation in ms (default: 30000, max: 300000) |
| `click_interactive` | boolean | no | Click interactive elements to reveal popups (default: true) |
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
          "triggerDescription": "Click me",
          "text": ["Hidden popup content"],
          "images": []
        }
      ]
    }
  ]
}
```

## Setup

```bash
npm install
npm run install:browsers   # install Playwright Chromium
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
