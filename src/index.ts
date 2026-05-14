#!/usr/bin/env node
import { startServer } from './server.js';

startServer().catch((err) => {
  process.stderr.write(`Fatal error starting genially-scraper: ${err}\n`);
  process.exit(1);
});
