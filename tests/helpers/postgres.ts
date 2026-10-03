import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** pool.end() can precede socket closure; let clients disconnect before stopping the fixture. */
export async function stopDisposablePostgres(dataDirectory: string): Promise<void> {
  try {
    await execute('pg_ctl', ['-D', dataDirectory, '-m', 'smart', '-w', '-t', '5', 'stop']);
  } catch (error) {
    // Clean up a failed fixture without turning the failed graceful shutdown into a passing test.
    try {
      await execute('pg_ctl', ['-D', dataDirectory, '-m', 'fast', '-w', '-t', '3', 'stop']);
    } catch {
      // Preserve the original teardown failure.
    }
    throw error;
  }
}
