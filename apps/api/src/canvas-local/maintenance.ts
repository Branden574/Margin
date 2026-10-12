import { Client, type PoolConfig } from 'pg';

// Database-scoped and version-independent. Shared runtime admission excludes operator maintenance.
const ADMISSION_KEY = [1296126535, 1128353366] as const;
export class CanvasAdmissionError extends Error {
  readonly name = 'CanvasAdmissionError';
}

export async function acquireCanvasRuntimeAdmission(
  config: PoolConfig,
  options: { signal?: AbortSignal } = {},
): Promise<{ signal: AbortSignal; close(): Promise<void> }> {
  if (
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ||
    process.env.PGREPLICATION ||
    process.env.PGBINARY ||
    typeof config.host !== 'string' ||
    !config.host ||
    config.host.startsWith('/') ||
    /[\s\u0000]/.test(config.host) ||
    !Number.isInteger(config.port) ||
    config.port! < 1 ||
    config.port! > 65535 ||
    typeof config.user !== 'string' ||
    !config.user ||
    typeof config.password !== 'string' ||
    !config.password ||
    typeof config.database !== 'string' ||
    !config.database ||
    !config.ssl ||
    typeof config.ssl !== 'object' ||
    config.ssl.rejectUnauthorized !== true ||
    !(typeof config.ssl.ca === 'string' || Buffer.isBuffer(config.ssl.ca)) ||
    !config.ssl.ca.length ||
    Object.keys(config.ssl).some((key) => !['ca', 'rejectUnauthorized'].includes(key)) ||
    config.connectionString
  )
    throw new CanvasAdmissionError(
      'Canvas admission requires explicit certificate-verified database credentials.',
    );
  options.signal?.throwIfAborted();
  const lost = new AbortController();
  const client = new Client({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    ssl: { ca: config.ssl.ca, rejectUnauthorized: true },
    sslnegotiation: 'postgres',
    options: '-c search_path=pg_catalog',
    client_encoding: 'UTF8',
    application_name: 'margin-canvas-runtime-admission',
    connectionTimeoutMillis: 5000,
    query_timeout: 6000,
    statement_timeout: 5000,
  });
  let closing: Promise<void> | undefined;
  const abort = () =>
    lost.abort(new CanvasAdmissionError('Canvas runtime admission was cancelled.'));
  const disconnected = () => {
    if (!closing)
      lost.abort(new CanvasAdmissionError('Canvas runtime database admission was lost.'));
  };
  client.on('error', disconnected);
  client.on('end', disconnected);
  options.signal?.addEventListener('abort', abort, { once: true });
  const close = () =>
    (closing ??= Promise.resolve().then(async () => {
      options.signal?.removeEventListener('abort', abort);
      await client.end();
    }));
  try {
    await client.connect();
    lost.signal.throwIfAborted();
    const tls = (await client.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()'))
      .rows[0];
    if (!tls?.ssl) throw new Error();
    const lock = (
      await client.query('SELECT pg_try_advisory_lock_shared($1,$2) AS acquired', [
        ...ADMISSION_KEY,
      ])
    ).rows[0];
    if (!lock?.acquired)
      throw new CanvasAdmissionError(
        'Canvas maintenance is active; runtime admission was refused.',
      );
    lost.signal.throwIfAborted();
    return { signal: lost.signal, close };
  } catch (error) {
    await close().catch(() => {});
    if (error instanceof CanvasAdmissionError) throw error;
    throw new CanvasAdmissionError('Canvas runtime database admission could not be established.');
  }
}

/** The caller owns this verified operator connection and must retain it until maintenance ends. */
export async function acquireCanvasMaintenance(client: Client): Promise<void> {
  const result = (
    await client.query('SELECT pg_try_advisory_lock($1,$2) AS acquired', [...ADMISSION_KEY])
  ).rows[0];
  if (!result?.acquired)
    throw new CanvasAdmissionError(
      'Stop the Canvas API and workers before upgrading this installation.',
    );
  await assertCanvasDatabaseQuiet(client);
}

export async function assertCanvasDatabaseQuiet(client: Client): Promise<void> {
  const result = (
    await client.query(
      "SELECT count(*)::integer AS connections FROM pg_stat_activity WHERE datid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND backend_type='client backend' AND pid<>pg_backend_pid()",
    )
  ).rows[0];
  if (result?.connections !== 0)
    throw new CanvasAdmissionError(
      'Other database clients are active; stop the Canvas API, workers and database sessions before upgrading.',
    );
}
