// Dump the server's OpenAPI document to a file without listening on a port.
//
// Assumes `npm run build` has already run: it imports the compiled app from
// dist/ (importing src/*.ts directly isn't possible from plain node). The
// storage is an in-memory SQLite database — no state is read or written.
//
// Usage: node scripts/dump-openapi.mjs [output-path]
//   output-path defaults to ../ui/shared/openapi.json (committed build
//   artifact: UI builds must not require booting the server).

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const output = resolve(here, '..', process.argv[2] ?? '../ui/shared/openapi.json');

let SqliteStorage, buildApp;
try {
  ({ SqliteStorage } = await import('../dist/src/storage/sqlite/index.js'));
  ({ buildApp } = await import('../dist/src/api/app.js'));
} catch (cause) {
  console.error('cannot load compiled server — run `npm run build` first');
  console.error(String(cause));
  process.exit(1);
}

const storage = new SqliteStorage(':memory:');
const app = await buildApp(storage);
await app.ready();

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(app.swagger(), null, 2) + '\n');
console.log(`OpenAPI document written to ${output}`);

await app.close();
storage.close();
