import { isAbsolute } from 'node:path';
import { PARSER_VERSION } from './protocol.js';

export type ScannerEngineKind = 'parser' | 'antivirus';
export interface ScannerSandbox {
  imageId: string;
  kind: ScannerEngineKind;
  uid: number;
  gid: number;
  definitionsDirectory?: string;
}
export interface ScannerContainerIdentity {
  id: string;
  name: string;
  owner: string;
}
const imageId = /^sha256:[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const containerId = /^[a-f0-9]{64}$/;
export const scannerOwnerLabel = 'com.margin.inspection.owner';
export const scannerName = /^margin-inspection-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export function sandboxLimits(kind: ScannerEngineKind) {
  return kind === 'parser'
    ? { memory: 1024 ** 3, work: 384 * 1024 ** 2, temporary: 16 * 1024 ** 2 }
    : { memory: 4 * 1024 ** 3, work: 128 * 1024 ** 2, temporary: 512 * 1024 ** 2 };
}
export function validateSandbox(value: ScannerSandbox) {
  if (
    !imageId.test(value.imageId) ||
    !['parser', 'antivirus'].includes(value.kind) ||
    !Number.isSafeInteger(value.uid) ||
    value.uid < 1 ||
    value.uid > 2147483647 ||
    !Number.isSafeInteger(value.gid) ||
    value.gid < 1 ||
    value.gid > 2147483647 ||
    (value.kind === 'parser' && value.definitionsDirectory !== undefined) ||
    (value.kind === 'antivirus' &&
      (typeof value.definitionsDirectory !== 'string' ||
        !isAbsolute(value.definitionsDirectory) ||
        /[\u0000-\u001f,]/.test(value.definitionsDirectory)))
  )
    throw new Error('Invalid isolated scanner configuration.');
}
export function scannerCreateArgs(
  sandbox: ScannerSandbox,
  identity: Omit<ScannerContainerIdentity, 'id'>,
) {
  validateSandbox(sandbox);
  if (!scannerName.test(identity.name) || !uuid.test(identity.owner))
    throw new Error('Invalid scanner container ownership.');
  const { memory, work, temporary } = sandboxLimits(sandbox.kind);
  const tmpfs = (size: number) =>
    `rw,noexec,nosuid,nodev,size=${size},mode=0700,uid=${sandbox.uid},gid=${sandbox.gid}`;
  return [
    'container',
    'create',
    '--pull=never',
    '--interactive',
    '--init',
    '--attach=stdin',
    '--attach=stdout',
    '--attach=stderr',
    '--name',
    identity.name,
    '--label',
    `${scannerOwnerLabel}=${identity.owner}`,
    '--network=none',
    '--read-only',
    '--user',
    `${sandbox.uid}:${sandbox.gid}`,
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--pids-limit=64',
    '--cpus=1',
    '--memory',
    String(memory),
    '--memory-swap',
    String(memory),
    '--ulimit',
    'core=0:0',
    '--ulimit',
    'nofile=256:256',
    '--restart=no',
    '--log-driver=none',
    '--ipc=none',
    '--tmpfs',
    `/work:${tmpfs(work)}`,
    '--tmpfs',
    `/tmp:${tmpfs(temporary)}`,
    ...(sandbox.kind === 'antivirus'
      ? [
          '--mount',
          `type=bind,src=${sandbox.definitionsDirectory},dst=/definitions,readonly,bind-propagation=rprivate`,
        ]
      : []),
    sandbox.imageId,
  ];
}
type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  return value as RecordValue;
};
export function verifyScannerImage(
  value: unknown,
  sandbox: ScannerSandbox,
  architecture: string,
): void {
  try {
    validateSandbox(sandbox);
    if (!['arm64', 'amd64'].includes(architecture) || !Array.isArray(value) || value.length !== 1)
      throw new Error();
    const image = object(value[0]),
      config = object(image.Config),
      labels = object(config.Labels);
    const expected =
      sandbox.kind === 'parser'
        ? {
            protocol: 'margin-pdf-inspection-v1',
            policy: PARSER_VERSION,
            entrypoint: ['node', '--max-old-space-size=512', '/app/runner.mjs'],
            environment: ['PATH', 'NODE_VERSION', 'YARN_VERSION'],
          }
        : {
            protocol: 'margin-av-inspection-v1',
            policy: 'clamav-1.4.6-policy-1',
            entrypoint: ['/opt/margin/scan.sh'],
            environment: ['PATH', 'DEBIAN_FRONTEND', 'TZ'],
          };
    const empty = (value: unknown) =>
      value == null ||
      (Array.isArray(value) ? value.length === 0 : Object.keys(object(value)).length === 0);
    if (
      image.Id !== sandbox.imageId ||
      image.Os !== 'linux' ||
      image.Architecture !== architecture ||
      labels['com.margin.inspection.protocol'] !== expected.protocol ||
      labels['com.margin.inspection.policy'] !== expected.policy ||
      JSON.stringify(config.Entrypoint) !== JSON.stringify(expected.entrypoint) ||
      !empty(config.Cmd) ||
      !empty(config.Volumes) ||
      !empty(config.OnBuild) ||
      config.WorkingDir !== '/work' ||
      config.User !== '65532:65532' ||
      (config.Healthcheck != null &&
        JSON.stringify(object(config.Healthcheck).Test) !== JSON.stringify(['NONE'])) ||
      !Array.isArray(config.Env)
    )
      throw new Error();
    const names = new Set<string>();
    for (const variable of config.Env) {
      if (
        typeof variable !== 'string' ||
        variable.length > 256 ||
        /[\u0000-\u001f\u007f]/.test(variable)
      )
        throw new Error();
      const split = variable.indexOf('='),
        name = variable.slice(0, split),
        value = variable.slice(split + 1);
      if (split < 1 || !expected.environment.includes(name) || names.has(name) || !value)
        throw new Error();
      names.add(name);
      if (
        name === 'PATH' &&
        value !== '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
      )
        throw new Error();
    }
    if (!names.has('PATH')) throw new Error();
  } catch {
    throw new Error('The image does not match the isolated scanner contract.');
  }
}
/** Cleanup verifies ownership independently of isolation so unsafe owned containers can be removed. */
export function verifyScannerOwnership(
  value: unknown,
  sandbox: ScannerSandbox,
  identity: Omit<ScannerContainerIdentity, 'id'> & { id?: string },
): { id: string; running: boolean } {
  try {
    validateSandbox(sandbox);
    if (
      !scannerName.test(identity.name) ||
      !uuid.test(identity.owner) ||
      (identity.id !== undefined && !containerId.test(identity.id)) ||
      !Array.isArray(value) ||
      value.length !== 1
    )
      throw new Error();
    const container = object(value[0]);
    if (
      typeof container.Id !== 'string' ||
      !containerId.test(container.Id) ||
      (identity.id !== undefined && container.Id !== identity.id) ||
      container.Name !== '/' + identity.name ||
      container.Image !== sandbox.imageId ||
      object(object(container.Config).Labels)[scannerOwnerLabel] !== identity.owner ||
      typeof object(container.State).Running !== 'boolean'
    )
      throw new Error();
    return { id: container.Id, running: object(container.State).Running as boolean };
  } catch {
    throw new Error('The scanner container ownership could not be verified.');
  }
}
/** Refuse inherited image volumes, elevated privileges, unexpected mounts and mutable image aliases. */
export function verifyScannerContainer(
  value: unknown,
  sandbox: ScannerSandbox,
  identity: Omit<ScannerContainerIdentity, 'id'> & { id?: string },
): { id: string; running: boolean; exitCode: number; oom: boolean; error: string } {
  try {
    validateSandbox(sandbox);
    verifyScannerOwnership(value, sandbox, identity);
    if (!Array.isArray(value) || value.length !== 1) throw new Error();
    const container = object(value[0]),
      config = object(container.Config),
      host = object(container.HostConfig);
    const labels = object(config.Labels),
      state = object(container.State);
    const limits = sandboxLimits(sandbox.kind);
    const mounts = container.Mounts;
    const empty = (v: unknown) => v === null || v === undefined || (Array.isArray(v) && !v.length);
    if (
      typeof container.Id !== 'string' ||
      !containerId.test(container.Id) ||
      container.Name !== '/' + identity.name ||
      container.Image !== sandbox.imageId ||
      labels[scannerOwnerLabel] !== identity.owner ||
      config.User !== `${sandbox.uid}:${sandbox.gid}` ||
      config.Tty !== false ||
      config.OpenStdin !== true ||
      config.AttachStdin !== true ||
      config.AttachStdout !== true ||
      config.AttachStderr !== true ||
      host.NetworkMode !== 'none' ||
      host.ReadonlyRootfs !== true ||
      host.Privileged !== false ||
      JSON.stringify(host.CapDrop) !== JSON.stringify(['ALL']) ||
      !empty(host.CapAdd) ||
      JSON.stringify(host.SecurityOpt) !== JSON.stringify(['no-new-privileges']) ||
      host.Memory !== limits.memory ||
      host.MemorySwap !== limits.memory ||
      host.NanoCpus !== 1_000_000_000 ||
      host.PidsLimit !== 64 ||
      host.Init !== true ||
      host.IpcMode !== 'none' ||
      object(host.RestartPolicy).Name !== 'no' ||
      object(host.LogConfig).Type !== 'none' ||
      !empty(host.Devices) ||
      !empty(host.DeviceRequests) ||
      !empty(host.VolumesFrom) ||
      !empty(host.Links) ||
      !empty(host.GroupAdd) ||
      host.PidMode !== '' ||
      host.UTSMode !== '' ||
      host.PublishAllPorts !== false ||
      (host.PortBindings !== null &&
        host.PortBindings !== undefined &&
        Object.keys(object(host.PortBindings)).length) ||
      !Array.isArray(mounts) ||
      typeof state.Running !== 'boolean' ||
      typeof state.OOMKilled !== 'boolean' ||
      !Number.isInteger(state.ExitCode) ||
      typeof state.Error !== 'string'
    )
      throw new Error();
    const ulimits = host.Ulimits;
    if (
      !Array.isArray(ulimits) ||
      ulimits.length !== 2 ||
      !ulimits.some(
        (limit) =>
          object(limit).Name === 'core' && object(limit).Soft === 0 && object(limit).Hard === 0,
      ) ||
      !ulimits.some(
        (limit) =>
          object(limit).Name === 'nofile' &&
          object(limit).Soft === 256 &&
          object(limit).Hard === 256,
      )
    )
      throw new Error();
    // Docker lists the exact host tmpfs specifications separately from bind/volume mounts.
    const tmpfs = object(host.Tmpfs);
    const expected = scannerCreateArgs(sandbox, identity);
    const specifications = expected.flatMap((arg, index) =>
      arg === '--tmpfs' ? [expected[index + 1]] : [],
    );
    if (
      Object.keys(tmpfs).length !== 2 ||
      specifications.some((specification) => {
        const split = specification.indexOf(':');
        return tmpfs[specification.slice(0, split)] !== specification.slice(split + 1);
      })
    )
      throw new Error();
    const bindings = mounts.filter((mount) => object(mount).Type !== 'tmpfs');
    if (sandbox.kind === 'parser') {
      if (bindings.length !== 0) throw new Error();
    } else {
      if (bindings.length !== 1) throw new Error();
      const bind = object(bindings[0]);
      if (
        bind.Type !== 'bind' ||
        bind.Source !== sandbox.definitionsDirectory ||
        bind.Destination !== '/definitions' ||
        bind.RW !== false ||
        bind.Propagation !== 'rprivate'
      )
        throw new Error();
    }
    if (
      mounts.some(
        (mount) =>
          object(mount).Type === 'tmpfs' &&
          !['/work', '/tmp'].includes(String(object(mount).Destination)),
      )
    )
      throw new Error();
    return {
      id: container.Id,
      running: state.Running,
      exitCode: state.ExitCode as number,
      oom: state.OOMKilled,
      error: state.Error,
    };
  } catch {
    throw new Error('The container does not match the isolated scanner policy.');
  }
}
