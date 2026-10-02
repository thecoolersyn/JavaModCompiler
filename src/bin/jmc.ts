#!/usr/bin/env node
import { main } from '../cli/run.js';
import { installSignalHandlers, isInterrupted, runCleanup } from '../platform/cleanup.js';

installSignalHandlers();

const exitCode = await main(process.argv.slice(2));
if (isInterrupted()) {
  await runCleanup('');
  process.exitCode = 130;
} else {
  process.exitCode = exitCode;
}