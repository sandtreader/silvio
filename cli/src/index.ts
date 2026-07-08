#!/usr/bin/env node
// Bin wrapper: wire run() to the process. All logic lives in run.ts.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { run } from './run.js';

const configPath = process.env['SILVIO_CONFIG'] ?? join(homedir(), '.silvio.json');
const result = await run(process.argv.slice(2), { configPath });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.code);
