import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformWithEsbuild } from 'vite';

export const OCR_PACK_ID = 'tesseract-7.0.0-eng-1';
export const OCR_BASE_URL = `/ocr/${OCR_PACK_ID}/`;
export const OCR_WORKER_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'none'";
const workspace = fileURLToPath(new URL('../', import.meta.url));
const versions = {
  'tesseract.js': '7.0.0',
  'tesseract.js-core': '7.0.0',
  '@tesseract.js-data/eng': '1.0.0',
};
const files = [
  ['tesseract.js/dist/worker.min.js', 'worker.min.js', 'text/javascript'],
  ['tesseract.js/dist/worker.min.js.LICENSE.txt', 'worker.min.js.LICENSE.txt', 'text/plain'],
  ['tesseract.js-core/LICENSE', 'LICENSE.tesseract-core.txt', 'text/plain'],
  ...['lstm', 'simd-lstm', 'relaxedsimd-lstm'].flatMap((variant) =>
    ['wasm.js', 'wasm'].map((extension) => [
      `tesseract.js-core/tesseract-core-${variant}.${extension}`,
      `core/tesseract-core-${variant}.${extension}`,
      extension === 'wasm' ? 'application/wasm' : 'text/javascript',
    ]),
  ),
  [
    '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz',
    'lang/eng.traineddata.gz',
    'application/gzip',
  ],
];

/** Copy only pinned public engine/model assets; never inspect workspace documents or vaults. */
export async function prepareOcrAssets({
  projectRoot = workspace,
  outputRoot = join(projectRoot, 'apps/web/public/ocr'),
} = {}) {
  const packages = [];
  for (const [name, version] of Object.entries(versions)) {
    const installed = JSON.parse(
      await readFile(join(projectRoot, 'node_modules', name, 'package.json'), 'utf8'),
    );
    if (installed.version !== version)
      throw new Error(`OCR requires ${name}@${version}; installed package does not match.`);
    packages.push({ name, version, license: installed.license, repository: installed.repository });
  }
  await mkdir(outputRoot, { recursive: true });
  const stage = join(outputRoot, `.stage-${randomUUID()}`);
  const destination = join(outputRoot, OCR_PACK_ID);
  const backup = join(outputRoot, `.previous-${randomUUID()}`);
  const assets = [];
  await mkdir(stage);
  try {
    const add = async (name, bytes, contentType) => {
      const output = join(stage, name);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, bytes);
      assets.push({
        path: `${OCR_BASE_URL}${name}`,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        contentType,
      });
    };
    for (const [source, name, contentType] of files)
      await add(name, await readFile(join(projectRoot, 'node_modules', source)), contentType);
    // The service worker and UI share one bounded verification implementation.
    // This small loader is safe to fetch at SW install; the model itself remains opt-in.
    const runtimePath = fileURLToPath(
      new URL('../apps/web/src/editor/ocrAssets.ts', import.meta.url),
    );
    const runtime = await transformWithEsbuild(await readFile(runtimePath, 'utf8'), runtimePath, {
      loader: 'ts',
      format: 'iife',
      globalName: 'MarginOcrAssets',
      target: 'es2022',
      sourcemap: false,
    });
    await add('ocr-runtime.js', Buffer.from(runtime.code), 'text/javascript');
    await add(
      'third-party-notices.json',
      Buffer.from(`${JSON.stringify({ packages }, null, 2)}\n`),
      'application/json',
    );
    const manifest = {
      schemaVersion: 1,
      packId: OCR_PACK_ID,
      baseUrl: OCR_BASE_URL,
      engine: { package: 'tesseract.js', version: '7.0.0', coreVersion: '7.0.0' },
      language: {
        code: 'eng',
        package: '@tesseract.js-data/eng',
        version: '1.0.0',
        variant: '4.0.0_best_int',
      },
      workerCsp: OCR_WORKER_CSP,
      totalBytes: assets.reduce((total, asset) => total + asset.bytes, 0),
      assets,
    };
    await writeFile(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    let previous = false;
    try {
      await rename(destination, backup);
      previous = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try {
      await rename(stage, destination);
    } catch (error) {
      if (previous) await rename(backup, destination);
      throw error;
    }
    if (previous) await rm(backup, { recursive: true });
    return manifest;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = await prepareOcrAssets();
  console.log(
    `Prepared local OCR ${manifest.packId}: ${manifest.assets.length} public assets, ${manifest.totalBytes} bytes. Runtime CDN access is not needed.`,
  );
}
