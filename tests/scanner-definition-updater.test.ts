import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScannerDefinitionsSnapshot } from '../infra/scanner/clamav/definitions.mjs';

const { setupScannerDefinitions } = (await import(
  new URL('../scripts/setup-scanner-definitions.mjs', import.meta.url).href
)) as {
  setupScannerDefinitions(options: {
    rootDirectory: string;
    image: string;
    refresh?: boolean;
  }): Promise<ScannerDefinitionsSnapshot & { changed: boolean }>;
};
let directory: string;
let bin: string;
let rootDirectory: string;
const image = `sha256:${'a'.repeat(64)}`;

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'margin-updater-test-')));
  bin = join(directory, 'bin');
  rootDirectory = join(directory, 'scanner');
  await mkdir(bin);
  // This fake CLI tests host lifecycle/publication only. It does not establish
  // signature authenticity; separate native checks exercise real FreshClam.
  await writeFile(
    join(bin, 'docker'),
    `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const home=__dirname;
const args=process.argv.slice(2);if(args[0]==='--host')args.splice(0,2);
fs.appendFileSync(path.join(home,'calls'),JSON.stringify(args)+'\\n');
const statePath=path.join(home,'state');
const state=()=>JSON.parse(fs.readFileSync(statePath,'utf8'));
const say=value=>process.stdout.write(typeof value==='string'?value:JSON.stringify(value));
if(args[0]==='context')say('unix:///tmp/fixture-docker.sock');
else if(args[0]==='image')say({Id:${JSON.stringify(image)},Architecture:'arm64',Os:'linux',Config:{Entrypoint:['/opt/margin/scan.sh'],Labels:{'com.margin.inspection.protocol':'margin-av-inspection-v1','com.margin.inspection.policy':'clamav-1.4.6-policy-1'}}});
else if(args[0]==='create'){
 const name=args[args.indexOf('--name')+1], label=args[args.indexOf('--label')+1].split('=')[1];
 const mount=args[args.indexOf('--mount')+1];const stage=mount.match(/source=(.*),target=/)[1];
 fs.writeFileSync(statePath,JSON.stringify({name,label,stage}));say('b'.repeat(64));
 if(fs.existsSync(path.join(home,'unknown-create')))process.exit(7);
}else if(args[0]==='start'){
 if(fs.existsSync(path.join(home,'fail')))process.exit(7);
 const s=state();const timestamp=Math.floor(Date.now()/1000)-60;
 for(const name of ['bytecode.cvd','daily.cvd','main.cvd']){
  const header=('ClamAV-VDB:11 Oct 2026 12-00 +0000:10:1:90:'+'0'.repeat(32)+':fixture:builder:'+timestamp).padEnd(512,' ');
  fs.writeFileSync(path.join(s.stage,name),header+'fixture',{mode:0o600});
 }
}else if(args[0]==='inspect'){
 if(fs.existsSync(path.join(home,'unknown-create')))process.exit(1);
 const s=state();say(args.includes('{{json .State}}')?{Running:false,ExitCode:0,OOMKilled:false}:{Id:'b'.repeat(64),Name:'/'+s.name,Config:{Image:${JSON.stringify(image)},Labels:{'io.margin.definitions-update':s.label}}});
}else if(!['rm','container'].includes(args[0]))process.exit(9);
`,
    { mode: 0o700 },
  );
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
async function calls(): Promise<string[][]> {
  return (await readFile(join(bin, 'calls'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}
describe('explicit definition updater publication', () => {
  it('publishes private bounded files, stops owned container, then reuses a fresh snapshot without Docker', async () => {
    const result = await setupScannerDefinitions({ rootDirectory, image });
    expect(result.changed).toBe(true);
    expect((await lstat(result.directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(result.directory, 'daily.cvd'))).mode & 0o777).toBe(0o400);
    expect((await lstat(join(rootDirectory, 'current.json'))).mode & 0o777).toBe(0o600);
    const before = await calls();
    expect(before.filter((call) => call[0] === 'rm')).toEqual([['rm', '--force', 'b'.repeat(64)]]);
    const create = before.find((call) => call[0] === 'create')!;
    expect(create).toContain('--network=bridge');
    expect(create).toContain('--read-only');
    expect(create).toContain('--memory=4g');
    expect(create.filter((value) => value.startsWith('type=bind'))).toHaveLength(1);
    expect(create).not.toContain('/var/run/docker.sock');
    const reused = await setupScannerDefinitions({ rootDirectory, image });
    expect(reused.changed).toBe(false);
    expect(reused.manifest.id).toBe(result.manifest.id);
    expect(await calls()).toEqual(before);
    expect(await readdir(rootDirectory)).not.toContain('.update-lock');
  });
  it('retains the previous pointer and snapshot after an updater failure and cleans only its exact container', async () => {
    const first = await setupScannerDefinitions({ rootDirectory, image });
    const pointer = await readFile(join(rootDirectory, 'current.json'));
    await writeFile(join(bin, 'fail'), 'controlled failure');
    await expect(
      setupScannerDefinitions({ rootDirectory, image, refresh: true }),
    ).rejects.toThrow();
    expect(await readFile(join(rootDirectory, 'current.json'))).toEqual(pointer);
    expect(await readFile(join(first.directory, 'manifest.json'), 'utf8')).toContain(
      first.manifest.id,
    );
    expect((await calls()).filter((call) => call[0] === 'rm')).toEqual([
      ['rm', '--force', 'b'.repeat(64)],
      ['rm', '--force', 'b'.repeat(64)],
    ]);
    expect(await readdir(rootDirectory)).not.toContain('.update-lock');
  });
  it('refuses a damaged existing snapshot before invoking Docker or replacing its pointer', async () => {
    const first = await setupScannerDefinitions({ rootDirectory, image });
    const before = await calls();
    const path = join(first.directory, 'daily.cvd');
    await chmod(path, 0o600);
    await writeFile(path, 'changed');
    await chmod(path, 0o400);
    await expect(setupScannerDefinitions({ rootDirectory, image, refresh: true })).rejects.toThrow(
      'failed validation',
    );
    expect(await calls()).toEqual(before);
  });
  it('journals unknown create before dispatch and retains admission when the daemon outcome cannot be proved', async () => {
    await writeFile(join(bin, 'unknown-create'), 'unknown acknowledgement');
    await expect(setupScannerDefinitions({ rootDirectory, image })).rejects.toThrow();
    const journal = JSON.parse(
      await readFile(join(rootDirectory, '.update-lock/operation.json'), 'utf8'),
    );
    expect(journal.state).toBe('creating');
    expect(journal.containerName).toBe(`margin-definitions-${journal.id}`);
    expect(journal.image).toBe(image);
    expect((await calls()).filter((call) => call[0] === 'rm')).toEqual([]);
    const before = await calls();
    await expect(setupScannerDefinitions({ rootDirectory, image })).rejects.toThrow(
      'operator recovery',
    );
    expect(await calls()).toEqual(before);
  });
});
