import { expect, it } from 'vitest';
import {
  scannerCreateArgs,
  verifyScannerContainer,
  verifyScannerImage,
  verifyScannerOwnership,
  scannerOwnerLabel,
  type ScannerSandbox,
} from '../apps/api/src/scanner/policy';
const sandbox: ScannerSandbox = {
  kind: 'parser',
  imageId: 'sha256:' + 'a'.repeat(64),
  uid: 501,
  gid: 20,
};
const identity = {
  id: 'b'.repeat(64),
  name: 'margin-inspection-11111111-1111-4111-8111-111111111111',
  owner: '22222222-2222-4222-8222-222222222222',
};
function containerFixture(): any {
  return [
    {
      Id: identity.id,
      Name: '/' + identity.name,
      Image: sandbox.imageId,
      Config: {
        User: '501:20',
        Tty: false,
        OpenStdin: true,
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Labels: { [scannerOwnerLabel]: identity.owner },
      },
      State: { Running: false, OOMKilled: false, ExitCode: 0, Error: '' },
      HostConfig: {
        NetworkMode: 'none',
        ReadonlyRootfs: true,
        Privileged: false,
        CapDrop: ['ALL'],
        CapAdd: null,
        SecurityOpt: ['no-new-privileges'],
        Memory: 1073741824,
        MemorySwap: 1073741824,
        NanoCpus: 1000000000,
        PidsLimit: 64,
        Init: true,
        IpcMode: 'none',
        RestartPolicy: { Name: 'no' },
        LogConfig: { Type: 'none' },
        Devices: [],
        DeviceRequests: null,
        VolumesFrom: null,
        Links: null,
        GroupAdd: null,
        PidMode: '',
        UTSMode: '',
        PublishAllPorts: false,
        PortBindings: {},
        Ulimits: [
          { Name: 'core', Soft: 0, Hard: 0 },
          { Name: 'nofile', Soft: 256, Hard: 256 },
        ],
        Tmpfs: {
          '/work': 'rw,noexec,nosuid,nodev,size=402653184,mode=0700,uid=501,gid=20',
          '/tmp': 'rw,noexec,nosuid,nodev,size=16777216,mode=0700,uid=501,gid=20',
        },
      },
      Mounts: [],
    },
  ];
}
it('admits the measured Docker container metadata and requires explicit no-pull isolation arguments', () => {
  expect(verifyScannerContainer(containerFixture(), sandbox, identity)).toMatchObject({
    id: identity.id,
    running: false,
  });
  const args = scannerCreateArgs(sandbox, identity);
  for (const arg of [
    '--pull=never',
    '--network=none',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--log-driver=none',
  ])
    expect(args).toContain(arg);
});
it.each([
  ['network', (v: any) => (v.HostConfig.NetworkMode = 'bridge')],
  ['root', (v: any) => (v.Config.User = '0:0')],
  ['writable root', (v: any) => (v.HostConfig.ReadonlyRootfs = false)],
  ['privileged', (v: any) => (v.HostConfig.Privileged = true)],
  ['seccomp override', (v: any) => v.HostConfig.SecurityOpt.push('seccomp=unconfined')],
  ['capability', (v: any) => (v.HostConfig.CapAdd = ['SYS_ADMIN'])],
  ['disk log', (v: any) => (v.HostConfig.LogConfig.Type = 'json-file')],
  ['swap', (v: any) => (v.HostConfig.MemorySwap = -1)],
  ['unbounded processes', (v: any) => (v.HostConfig.PidsLimit = 0)],
  ['inherited volume', (v: any) => (v.Mounts = [{ Type: 'volume', Destination: '/data' }])],
  ['extra tmpfs', (v: any) => (v.Mounts = [{ Type: 'tmpfs', Destination: '/escape' }])],
  ['writable tmpfs mode', (v: any) => (v.HostConfig.Tmpfs['/tmp'] += 'exec')],
  ['core dump', (v: any) => (v.HostConfig.Ulimits[0].Soft = 1000)],
  ['missing stdin', (v: any) => (v.Config.AttachStdin = false)],
])(
  'rejects unsafe %s while still identifying the owned container for cleanup',
  (_label, mutate) => {
    const value = containerFixture();
    (mutate as (v: any) => void)(value[0]);
    expect(() => verifyScannerContainer(value, sandbox, identity)).toThrow('policy');
    expect(verifyScannerOwnership(value, sandbox, identity).id).toBe(identity.id);
  },
);
it.each(['id', 'name', 'owner', 'image'])(
  'refuses cleanup of a container with a different %s',
  (kind) => {
    const value = containerFixture();
    if (kind === 'id') value[0].Id = 'c'.repeat(64);
    if (kind === 'name') value[0].Name = '/foreign';
    if (kind === 'owner') value[0].Config.Labels[scannerOwnerLabel] = 'foreign';
    if (kind === 'image') value[0].Image = 'sha256:' + 'd'.repeat(64);
    expect(() => verifyScannerOwnership(value, sandbox, identity)).toThrow('ownership');
  },
);
it('admits only the exact readonly definition mount and bounded AV memory', () => {
  const av: ScannerSandbox = {
    ...sandbox,
    kind: 'antivirus',
    definitionsDirectory: '/private/definitions/snapshot',
  };
  const value = containerFixture();
  value[0].HostConfig.Memory = value[0].HostConfig.MemorySwap = 4294967296;
  value[0].HostConfig.Tmpfs['/work'] =
    'rw,noexec,nosuid,nodev,size=134217728,mode=0700,uid=501,gid=20';
  value[0].HostConfig.Tmpfs['/tmp'] =
    'rw,noexec,nosuid,nodev,size=536870912,mode=0700,uid=501,gid=20';
  value[0].Mounts = [
    {
      Type: 'bind',
      Source: av.definitionsDirectory,
      Destination: '/definitions',
      RW: false,
      Propagation: 'rprivate',
    },
  ];
  expect(verifyScannerContainer(value, av, identity).id).toBe(identity.id);
  value[0].Mounts[0].RW = true;
  expect(() => verifyScannerContainer(value, av, identity)).toThrow();
  value[0].Mounts[0].RW = false;
  value[0].Mounts[0].Source = '/private/foreign';
  expect(() => verifyScannerContainer(value, av, identity)).toThrow();
});
function imageFixture(): any {
  return [
    {
      Id: sandbox.imageId,
      Os: 'linux',
      Architecture: 'arm64',
      Config: {
        User: '65532:65532',
        WorkingDir: '/work',
        Entrypoint: ['node', '--max-old-space-size=512', '/app/runner.mjs'],
        Env: [
          'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
          'NODE_VERSION=22.22.0',
          'YARN_VERSION=1.22.22',
        ],
        Labels: {
          'com.margin.inspection.protocol': 'margin-pdf-inspection-v1',
          'com.margin.inspection.policy': 'qpdf-12.4.2+pdfjs-6.3.289+policy-1',
        },
      },
    },
  ];
}
it('verifies immutable native engine identity and refuses executable/environment overrides', () => {
  expect(() => verifyScannerImage(imageFixture(), sandbox, 'arm64')).not.toThrow();
  for (const mutate of [
    (v: any) => (v.Architecture = 'amd64'),
    (v: any) => v.Config.Env.push('NODE_OPTIONS=--require=/bad'),
    (v: any) => (v.Config.Cmd = ['sh']),
    (v: any) => (v.Config.Volumes = { '/data': {} }),
    (v: any) => (v.Config.Entrypoint = ['sh']),
    (v: any) => (v.Config.Labels['com.margin.inspection.policy'] = 'unknown'),
    (v: any) => (v.Config.Healthcheck = { Test: ['CMD', 'sh'] }),
    (v: any) => (v.Id = 'sha256:' + 'e'.repeat(64)),
  ]) {
    const value = imageFixture();
    mutate(value[0]);
    expect(() => verifyScannerImage(value, sandbox, 'arm64')).toThrow('contract');
  }
});
