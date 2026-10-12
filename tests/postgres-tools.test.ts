import { describe, expect, it } from 'vitest';
import { postgresTlsToolsAvailable } from './helpers/postgres-tools';

describe('PostgreSQL/TLS test tool detection', () => {
  it('accepts an OpenSSL probe that supports the version subcommand but rejects --version', () => {
    const calls: Array<[string, string[]]> = [];
    const probe = (command: string, args: string[]) => {
      calls.push([command, args]);
      if (args.length !== 1 || args[0] !== (command === 'openssl' ? 'version' : '--version'))
        throw new Error('Unsupported version command.');
    };
    expect(postgresTlsToolsAvailable('fixture', probe, true)).toBe(true);
    expect(calls.map(([command]) => command)).toEqual(['initdb', 'pg_ctl', 'openssl']);
  });

  it('keeps mandatory tests failing and identifies all missing tools without raw command errors', () => {
    const probe = (command: string) => {
      if (command !== 'pg_ctl') throw new Error('Untrusted command output or connection secret.');
    };
    expect(() => postgresTlsToolsAvailable('fixture', probe, true)).toThrow(
      'Required fixture PostgreSQL/TLS tooling is unavailable: initdb, openssl.',
    );
    expect(postgresTlsToolsAvailable('fixture', probe, false)).toBe(false);
  });
});
