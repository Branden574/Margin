import { resolve } from 'node:path';
import {
  startLocalScanner,
  LocalScannerCleanupPendingError,
  LocalScannerStartupError,
} from './scanner/local-runtime.js';

const args = process.argv.slice(2);
if (args.length > 1) {
  process.stderr.write(
    'Usage: npm run dev:canvas:scanner -- /absolute/path/to/scanner/inspector.json\n',
  );
  process.exitCode = 1;
} else {
  const stop = new AbortController();
  let runtime: Awaited<ReturnType<typeof startLocalScanner>> | undefined;
  let retryCleanup: (() => Promise<void>) | undefined;
  let closing: Promise<void> | undefined;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  const releaseSignals = () => {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    clearInterval(keepAlive);
    keepAlive = undefined;
  };
  const pending = (error: unknown) => {
    process.exitCode = 1;
    if (error instanceof LocalScannerCleanupPendingError) retryCleanup = error.retryClose;
    process.stderr.write(
      'Local source inspection cleanup is pending. Keep this process open, restore the required local services, then send Ctrl-C again to retry owned cleanup. Any unfinished executor journal and lock remain preserved.\n',
    );
    // Keep retry ownership in this process even after the database lease was lost.
    keepAlive ??= setInterval(() => {}, 60000);
  };
  function shutdown() {
    stop.abort();
    if (closing || (!runtime && !retryCleanup)) return;
    const work = retryCleanup ?? (() => runtime!.close());
    const close = Promise.resolve().then(work);
    closing = close;
    void close.then(
      () => {
        releaseSignals();
      },
      (error) => {
        closing = undefined;
        pending(error);
      },
    );
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  try {
    runtime = await startLocalScanner(args[0] ?? resolve('.local/canvas/scanner/inspector.json'), {
      signal: stop.signal,
      onEvent: (event) => {
        if (event === 'deferred')
          process.stderr.write(
            'Local source inspection deferred a job; its durable queue controls retry.\n',
          );
      },
    });
    const lost = () => {
      if (stop.signal.aborted) return;
      process.stderr.write(
        'Local source inspection stopped because its database maintenance admission was lost.\n',
      );
      process.exitCode = 1;
      shutdown();
    };
    runtime.signal.addEventListener('abort', lost, { once: true });
    if (runtime.signal.aborted) lost();
    if (stop.signal.aborted) shutdown();
    else
      process.stdout.write(
        'Margin local source inspector is ready: verified database, isolated PDF parser and current signed antivirus definitions. This separate worker processes the durable inspection queue.\n',
      );
  } catch (error) {
    if (error instanceof LocalScannerCleanupPendingError) pending(error);
    else {
      process.stderr.write(new LocalScannerStartupError().message + '\n');
      process.exitCode = stop.signal.aborted ? 0 : 1;
      releaseSignals();
    }
  }
}
