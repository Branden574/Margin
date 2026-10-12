import { execFileSync } from 'node:child_process';

type VersionProbe = (command: string, args: string[]) => void;
const runVersion: VersionProbe = (command, args) => {
  execFileSync(command, args, { stdio: 'pipe', timeout: 5000, maxBuffer: 16384 });
};

/** OpenSSL uses the version subcommand; --version is not portable across releases. */
export function postgresTlsToolsAvailable(
  suite: string,
  probe: VersionProbe = runVersion,
  required = process.env.MARGIN_REQUIRE_POSTGRES_TESTS === '1',
): boolean {
  const missing: string[] = [];
  for (const [command, args] of [
    ['initdb', ['--version']],
    ['pg_ctl', ['--version']],
    ['openssl', ['version']],
  ] as const) {
    try {
      probe(command, [...args]);
    } catch {
      missing.push(command);
    }
  }
  if (required && missing.length)
    throw new Error(
      `Required ${suite} PostgreSQL/TLS tooling is unavailable: ${missing.join(', ')}.`,
    );
  return missing.length === 0;
}
