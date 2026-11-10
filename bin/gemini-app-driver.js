#!/usr/bin/env node
import { main } from '../src/cli.js';

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
