import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const output = fileURLToPath(new URL('../.next/', import.meta.url));
const html = await readFile(path.join(output, 'server/app/index.html'), 'utf8');
const scripts = [
  ...new Set(
    [...html.matchAll(/<script[^>]+src="(\/_next\/static\/[^"?]+\.js)/g)].map((match) => match[1]),
  ),
];
if (!scripts.length)
  throw new Error('No built homepage scripts found. Run the marketing production build first.');
let bytes = 0;
for (const script of scripts) {
  const location = path.resolve(output, script.slice('/_next/'.length));
  if (!location.startsWith(path.join(output, 'static') + path.sep))
    throw new Error('Unexpected script path in build output.');
  bytes += gzipSync(await readFile(location)).length;
}
const budget = 250_000;
console.log(
  JSON.stringify(
    {
      scripts: scripts.length,
      gzipBytes: bytes,
      budgetBytes: budget,
      withinBudget: bytes <= budget,
      scope:
        'Gzip estimate for scripts referenced by built homepage HTML. Excludes deferred chunks, HTML/RSC, CSS, and fonts. Not a network trace, Lighthouse result, or field Web Vitals measurement.',
    },
    null,
    2,
  ),
);
if (bytes > budget) process.exitCode = 1;
