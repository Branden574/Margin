#!/usr/bin/env node
import { setupLocalScanner } from '../apps/api/src/scanner/local-setup.ts';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--help'))
  process.stdout.write(
    'Usage: node --import tsx scripts/setup-scanner-local.mjs --canvas-root PATH --parser-image sha256:ID --antivirus-image sha256:ID --definitions-root PATH --docker-executable PATH --docker-socket PATH\nAdds a separate restricted inspector credential and companion configuration. Stop the Canvas API/workers first. Original protected files are preserved; no inspector process starts.\n',
  );
else
  try {
    const known = new Set([
      '--canvas-root',
      '--parser-image',
      '--antivirus-image',
      '--definitions-root',
      '--docker-executable',
      '--docker-socket',
    ]);
    const values = new Map();
    for (let i = 0; i < args.length; i += 2) {
      const name = args[i],
        value = args[i + 1];
      if (!known.has(name) || !value || value.startsWith('--') || values.has(name))
        throw new Error();
      values.set(name, value);
    }
    if (values.size !== known.size) throw new Error();
    const result = await setupLocalScanner({
      canvasRoot: resolve(values.get('--canvas-root')),
      parserImage: values.get('--parser-image'),
      antivirusImage: values.get('--antivirus-image'),
      definitionsDirectory: resolve(values.get('--definitions-root')),
      dockerExecutable: resolve(values.get('--docker-executable')),
      dockerSocketPath: resolve(values.get('--docker-socket')),
    });
    process.stdout.write(
      `Local inspector configuration ${result.changed ? 'installed' : 'verified'}${result.reconciled ? ' after reconciling its saved setup journal' : ''}: ${result.configPath}\nOriginal Canvas credentials, keys and artifacts were preserved. The inspector has not been started.\n`,
    );
  } catch {
    process.stderr.write(
      'Local inspector setup did not complete. Existing files and its private setup journal were preserved; verify maintenance admission, engine readiness and the dedicated installation before retrying.\n',
    );
    process.exitCode = 1;
  }
