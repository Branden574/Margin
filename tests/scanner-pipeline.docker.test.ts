import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDockerScannerExecutor,
  type DockerScannerExecutor,
} from '../apps/api/src/scanner/docker';
import { IsolatedSourceScanner } from '../apps/api/src/scanner/source';
import { scannerCommand } from '../apps/api/src/scanner/process';
import { checkDedicatedDirectory } from '../apps/api/src/canvas-local/protected-files';
import {
  benignPdf,
  geometryPdf,
  activePdf,
  decodedBombPdf,
  pdfObjects,
  sourceObjects,
  pdfStream,
} from './helpers/scanner-pdf-fixtures';
const names = [
  'MARGIN_PDF_PARSER_IMAGE',
  'MARGIN_CLAMAV_IMAGE',
  'MARGIN_SCANNER_DOCKER_BIN',
  'MARGIN_SCANNER_DOCKER_SOCKET',
  'MARGIN_SCANNER_DEFINITIONS',
] as const;
const configured = names.every((name) => !!process.env[name]);
if (names.some((name) => !!process.env[name]) && !configured)
  throw new Error(
    'Real scanner pipeline tests require all five explicit engine/endpoint/definition settings.',
  );
const suite = configured ? describe : describe.skip;
let root: string,
  scanner: IsolatedSourceScanner | undefined,
  executor: DockerScannerExecutor | undefined;
suite('real isolated PDF+AV pipeline (explicit local engines and signed definitions)', () => {
  beforeEach(async () => {
    const parent = resolve('.local/scanner-pipeline-test');
    await checkDedicatedDirectory(parent);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await checkDedicatedDirectory(parent);
    root = await realpath(await mkdtemp(join(parent, 'case-')));
    executor = await createDockerScannerExecutor({
      executable: process.env.MARGIN_SCANNER_DOCKER_BIN!,
      socketPath: process.env.MARGIN_SCANNER_DOCKER_SOCKET!,
      stateDirectory: join(root, 'executor'),
    });
    scanner = new IsolatedSourceScanner(executor, {
      parserImage: process.env.MARGIN_PDF_PARSER_IMAGE!,
      antivirusImage: process.env.MARGIN_CLAMAV_IMAGE!,
      definitionsDirectory: process.env.MARGIN_SCANNER_DEFINITIONS!,
      uid: process.getuid!(),
      gid: process.getgid!(),
    });
    await scanner.ready(AbortSignal.timeout(10000));
  }, 15000);
  afterEach(async () => {
    // Never erase ownership evidence when the daemon cannot prove cleanup.
    await scanner?.close();
    scanner = undefined;
    expect(executor?.status().pendingCleanup).toBe(0);
    executor = undefined;
    await rm(root, { recursive: true });
  }, 60000);
  it('approves a real benign PDF only after both engines and preserves exact inspected geometry', async () => {
    const start = performance.now(),
      bytes = geometryPdf(),
      original = Buffer.from(bytes);
    const verdict = await scanner!.inspect(bytes, AbortSignal.timeout(45000));
    expect(verdict).toMatchObject({
      verdict: 'ready',
      reason: 'clean',
      engine: 'qpdf-pdfjs-clamav',
      pageCount: 1,
      pageGeometry: [{ index: 0, width: 1340, height: 960 }],
    });
    expect(verdict.definitionsVersion).toMatch(/^[a-f0-9]{64}$/);
    expect(bytes.equals(original)).toBe(true);
    expect(executor!.status()).toMatchObject({ busy: false, pendingCleanup: 0 });
    console.info(
      `Actual isolated parser+ClamAV including readiness and confirmed container cleanup: ${Math.round(performance.now() - start)}ms`,
    );
  }, 60000);
  it('detects the standard harmless EICAR signature inside an otherwise valid PDF', async () => {
    // EICAR is a public antivirus test string, never executable malware or user content.
    const eicar = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
    const bytes = pdfObjects(sourceObjects({ extra: [pdfStream(Buffer.from(eicar))] }));
    const verdict = await scanner!.inspect(bytes, AbortSignal.timeout(45000));
    expect(verdict).toMatchObject({ verdict: 'rejected', reason: 'malware', pageCount: 0 });
    expect(verdict.pageGeometry).toBeUndefined();
  }, 60000);
  it('rejects active content and malformed documents without an invented AV approval', async () => {
    for (const bytes of [activePdf(true), Buffer.from('%PDF-1.7\nmalformed fixture')]) {
      const verdict = await scanner!.inspect(bytes, AbortSignal.timeout(45000));
      expect(verdict.verdict).toBe('rejected');
      expect(['unsupported', 'invalid_document']).toContain(verdict.reason);
      expect(verdict.engine).toBe('qpdf-pdfjs');
      expect(verdict.definitionsVersion).toBe('none');
    }
  }, 60000);
  it('keeps a real decoded-content limit quarantined and removes the stopped container', async () => {
    await expect(scanner!.inspect(decodedBombPdf(), AbortSignal.timeout(45000))).rejects.toThrow(
      'quarantined',
    );
    expect(executor!.status()).toMatchObject({ busy: false, pendingCleanup: 0 });
  }, 60000);
  it('cancels a running real AV container, waits for removal, then admits another document', async () => {
    const controller = new AbortController();
    const pending = scanner!.inspect(benignPdf(), controller.signal);
    const outcome = pending.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    let observed: string | undefined;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !observed) {
      for (const filename of await readdir(join(root, 'executor'))) {
        if (!filename.endsWith('.jsonl')) continue;
        let text: string;
        try {
          text = await readFile(join(root, 'executor', filename), 'utf8');
        } catch {
          continue;
        }
        const lines = text.split('\n').filter(Boolean);
        const last = JSON.parse(lines.at(-1)!);
        if (last.sandbox?.kind !== 'antivirus' || last.phase !== 'identified') continue;
        const result = await scannerCommand(
          process.env.MARGIN_SCANNER_DOCKER_BIN!,
          [
            '--host',
            'unix://' + process.env.MARGIN_SCANNER_DOCKER_SOCKET!,
            'container',
            'inspect',
            last.id,
          ],
          { timeoutMs: 5000 },
        );
        if (result.exitCode === 0 && JSON.parse(result.stdout.toString())[0].State.Running)
          observed = last.id;
      }
      if (!observed) await delay(20);
    }
    try {
      expect(observed).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      controller.abort();
    }
    expect(await outcome).toHaveProperty('error');
    expect(executor!.status()).toMatchObject({ busy: false, pendingCleanup: 0 });
    const remaining = await scannerCommand(process.env.MARGIN_SCANNER_DOCKER_BIN!, [
      '--host',
      'unix://' + process.env.MARGIN_SCANNER_DOCKER_SOCKET!,
      'container',
      'ls',
      '--all',
      '--no-trunc',
      '--filter',
      'id=' + observed,
      '--format',
      '{{.ID}}',
    ]);
    expect(remaining.exitCode).toBe(0);
    expect(remaining.stdout.toString().trim()).toBe('');
    expect((await scanner!.inspect(benignPdf(), AbortSignal.timeout(45000))).verdict).toBe('ready');
  }, 60000);
});
