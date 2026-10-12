import { readScannerDefinitions } from '../../../../infra/scanner/clamav/definitions.mjs';
import type { SourceScanner } from '../ingestion/types.js';
import type { ScannerSandbox } from './policy.js';
import type { ScannerCommandResult } from './process.js';
import {
  ANTIVIRUS_VERSION,
  PARSER_VERSION,
  ScannerUnavailableError,
  decodeAntivirusResult,
  decodeParserResult,
} from './protocol.js';

export interface IsolatedScannerExecutor {
  ready(signal: AbortSignal): Promise<void>;
  checkSandbox(sandbox: ScannerSandbox, signal: AbortSignal): Promise<void>;
  execute(
    sandbox: ScannerSandbox,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<ScannerCommandResult>;
  close(): Promise<void>;
}
export interface IsolatedSourceScannerOptions {
  parserImage: string;
  antivirusImage: string;
  definitionsDirectory: string;
  uid: number;
  gid: number;
}
type Verdict = Awaited<ReturnType<SourceScanner['inspect']>>;
/** Serial inspection; only the owned executor may release a container after confirmed cleanup. */
export class IsolatedSourceScanner implements SourceScanner {
  private readonly stopping = new AbortController();
  private active: Promise<unknown> | undefined;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly executor: IsolatedScannerExecutor,
    private readonly options: IsolatedSourceScannerOptions,
  ) {}

  private check(signal: AbortSignal) {
    if (signal.aborted) throw new ScannerUnavailableError();
  }
  private exclusive<T>(
    external: AbortSignal,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.active || this.stopping.signal.aborted || external.aborted)
      return Promise.reject(new ScannerUnavailableError());
    const signal = AbortSignal.any([external, this.stopping.signal]);
    const pending = Promise.resolve().then(() => {
      this.check(signal);
      return work(signal);
    });
    this.active = pending;
    const release = () => {
      if (this.active === pending) this.active = undefined;
    };
    void pending.then(release, release);
    return pending;
  }
  private async prepare(signal: AbortSignal) {
    await this.executor.ready(signal);
    this.check(signal);
    const definitions = await readScannerDefinitions(this.options.definitionsDirectory);
    this.check(signal);
    const parser: ScannerSandbox = {
      kind: 'parser',
      imageId: this.options.parserImage,
      uid: this.options.uid,
      gid: this.options.gid,
    };
    const antivirus: ScannerSandbox = {
      kind: 'antivirus',
      imageId: this.options.antivirusImage,
      uid: this.options.uid,
      gid: this.options.gid,
      definitionsDirectory: definitions.directory,
    };
    await this.executor.checkSandbox(parser, signal);
    this.check(signal);
    await this.executor.checkSandbox(antivirus, signal);
    this.check(signal);
    return { parser, antivirus };
  }
  ready(signal: AbortSignal): Promise<void> {
    return this.exclusive(signal, async (signal) => {
      await this.prepare(signal);
    });
  }
  inspect(bytes: Uint8Array, signal: AbortSignal): Promise<Verdict> {
    return this.exclusive(signal, async (signal) => {
      if (
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength < 1 ||
        bytes.byteLength > 100 * 1024 * 1024
      )
        throw new ScannerUnavailableError();
      const { parser, antivirus } = await this.prepare(signal);
      const parsedOutput = await this.executor.execute(parser, bytes, signal);
      let parsed;
      try {
        this.check(signal);
        parsed = decodeParserResult(parsedOutput);
      } finally {
        parsedOutput.stdout.fill(0);
      }
      if (parsed.status === 'rejected')
        return {
          verdict: 'rejected',
          engine: 'qpdf-pdfjs',
          engineVersion: PARSER_VERSION,
          definitionsVersion: 'none',
          pageCount: 0,
          reason: parsed.reason,
        };
      // Readiness can expire during a long parser run. Validate the current signed snapshot
      // immediately before the AV launch and bind exactly the returned version into the report.
      const current = await readScannerDefinitions(this.options.definitionsDirectory);
      this.check(signal);
      antivirus.definitionsDirectory = current.directory;
      const avOutput = await this.executor.execute(antivirus, bytes, signal);
      let av;
      try {
        this.check(signal);
        av = decodeAntivirusResult(avOutput);
      } finally {
        avOutput.stdout.fill(0);
      }
      // Keep no raw engine output or document text in the durable inspection result.
      return {
        verdict: av === 'clean' ? 'ready' : 'rejected',
        engine: 'qpdf-pdfjs-clamav',
        engineVersion: `${PARSER_VERSION}+clamav-${ANTIVIRUS_VERSION}`,
        definitionsVersion: current.manifestSha256,
        pageCount: av === 'clean' ? parsed.pageCount : 0,
        ...(av === 'clean' ? { pageGeometry: parsed.pageGeometry } : {}),
        reason: av,
      };
    });
  }
  close(): Promise<void> {
    this.stopping.abort();
    if (this.closing) return this.closing;
    // Failure leaves executor cleanup pending; callers may explicitly retry close.
    const closing = (async () => {
      await this.active?.catch(() => {});
      await this.executor.close();
    })();
    this.closing = closing;
    void closing.catch(() => {
      if (this.closing === closing) this.closing = undefined;
    });
    return closing;
  }
}
