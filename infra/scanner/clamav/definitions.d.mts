export const CLAMAV_BASE_IMAGE: string;
export const CLAMAV_VERSION: '1.4.6';
export const DEFINITION_NAMES: readonly ['bytecode.cvd', 'daily.cvd', 'main.cvd'];
export const MAX_DEFINITION_BYTES: number;
export class ScannerDefinitionsError extends Error {}
export type ScannerDefinitionsManifest = {
  schemaVersion: 1;
  id: string;
  engine: 'clamav';
  engineVersion: '1.4.6';
  baseImage: string;
  confirmedAt: string;
  files: {
    name: 'bytecode.cvd' | 'daily.cvd' | 'main.cvd';
    bytes: number;
    sha256: string;
    version: number;
    builtAt: string;
  }[];
};
export type ScannerDefinitionsSnapshot = {
  directory: string;
  manifest: ScannerDefinitionsManifest;
  manifestSha256: string;
};
export function readScannerDefinitions(
  rootDirectory: string,
  options?: { now?: Date },
): Promise<ScannerDefinitionsSnapshot>;
/** Only for updater reuse; never authorizes document inspection. */
export function readScannerDefinitionsForUpdate(
  rootDirectory: string,
  options?: { now?: Date },
): Promise<ScannerDefinitionsSnapshot>;
export function privateDirectory(path: string, mode?: number): Promise<void>;
export function readPrivateDefinitionFile(
  path: string,
  maxBytes: number,
  mode?: number,
): Promise<{ bytes: number; sha256: string; header: Buffer; text?: string }>;
export function cvdMetadata(header: Buffer): { version: number; builtAt: string };
