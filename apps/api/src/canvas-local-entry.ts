import { resolve } from 'node:path';
import { startCanvasLocalApi } from './runtime-canvas-local.js';
import { CanvasLocalConfigError } from './canvas-local/config.js';

const args = process.argv.slice(2);
if (args.length > 1) {
  process.stderr.write('Usage: npm run dev:canvas:api -- /absolute/path/to/config.json\n');
  process.exitCode = 1;
} else {
  const stop = new AbortController();
  let runtime: Awaited<ReturnType<typeof startCanvasLocalApi>> | undefined;
  let closing: Promise<void> | undefined;
  const shutdown = () => {
    stop.abort();
    if (!runtime) return;
    closing ??= runtime.close().catch(() => {
      process.stderr.write(
        'Local Canvas shutdown did not complete cleanly. Check the protected configuration before restarting.\n',
      );
      process.exitCode = 1;
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  try {
    runtime = await startCanvasLocalApi(args[0] ?? resolve('.local/canvas/config.json'), {
      signal: stop.signal,
      onWorkerEvent: ({ worker }) =>
        process.stderr.write(
          `Canvas ${worker} worker deferred a job; the durable queue controls retry.\n`,
        ),
    });
    if (stop.signal.aborted) shutdown();
    else
      process.stdout.write(
        `Margin local Canvas API: ${runtime.origin}\nWorkspace origin: ${runtime.applicationOrigin}\nLTI-only sessions; persistent student copies and snapshot processing. Canvas registration, source scanning and live Canvas delivery remain separately required.\n`,
      );
  } catch (error) {
    // Never print native database errors, configuration contents, key paths or connection strings.
    process.stderr.write(
      error instanceof CanvasLocalConfigError
        ? `Local Canvas startup refused: ${error.message}\n`
        : 'Local Canvas startup refused. Verify database readiness, protected configuration and the available listener port.\n',
    );
    process.exitCode = stop.signal.aborted ? 0 : 1;
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
  }
}
