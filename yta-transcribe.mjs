#!/usr/bin/env node

/**
 * Root wrapper entry point for backwards compatibility.
 * Delegates to bin/yta-transcribe.mjs module.
 */
import { runCli } from './bin/yta-transcribe.mjs';

runCli().catch(err => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});
