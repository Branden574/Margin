import { strictJson } from '../strict-json.js';
import { geometry } from '../ingestion/validation.js';
import type { SourcePageGeometry } from '../ingestion/types.js';
import type { ScannerCommandResult } from './process.js';

export const PARSER_VERSION = 'qpdf-12.4.2+pdfjs-6.3.289+policy-1';
export const ANTIVIRUS_VERSION = '1.4.6';
export class ScannerUnavailableError extends Error {
  readonly name = 'ScannerUnavailableError';
  constructor() {
    super(
      'Document inspection is unavailable or exceeded its resource limits. The document remains quarantined.',
    );
  }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).sort().join(',') !== keys.sort().join(',')) throw new Error();
}
function decode(result: ScannerCommandResult, maximum: number) {
  if (!Buffer.isBuffer(result.stdout) || result.stdout.length < 1 || result.stdout.length > maximum)
    throw new Error();
  return record(strictJson(new TextDecoder('utf-8', { fatal: true }).decode(result.stdout)));
}
export type ParserResult =
  | { status: 'valid'; pageCount: number; pageGeometry: SourcePageGeometry[] }
  | { status: 'rejected'; reason: 'unsupported' | 'invalid_document' };
export function decodeParserResult(result: ScannerCommandResult): ParserResult {
  try {
    const value = decode(result, 262144);
    const keys = ['protocol', 'status', 'reason', 'engine', 'engineVersion', 'pageCount'];
    if (
      value.protocol !== 'margin-pdf-inspection-v1' ||
      value.engine !== 'qpdf-pdfjs' ||
      value.engineVersion !== PARSER_VERSION
    )
      throw new Error();
    if (value.status === 'valid') {
      fields(value, [...keys, 'pageGeometry']);
      if (
        result.exitCode !== 0 ||
        value.reason !== 'clean' ||
        !Number.isSafeInteger(value.pageCount) ||
        (value.pageCount as number) < 1 ||
        (value.pageCount as number) > 2000 ||
        !Array.isArray(value.pageGeometry)
      )
        throw new Error();
      for (const page of value.pageGeometry) fields(record(page), ['index', 'width', 'height']);
      return {
        status: 'valid',
        pageCount: value.pageCount as number,
        pageGeometry: geometry(
          value.pageGeometry as SourcePageGeometry[],
          value.pageCount as number,
        ),
      };
    }
    fields(value, keys);
    if (
      result.exitCode !== 10 ||
      value.status !== 'rejected' ||
      value.pageCount !== 0 ||
      !['unsupported', 'invalid_document'].includes(value.reason as string)
    )
      throw new Error();
    return { status: 'rejected', reason: value.reason as 'unsupported' | 'invalid_document' };
  } catch {
    // A resource limit, crash, malformed output or mismatched engine is never an approval.
    throw new ScannerUnavailableError();
  }
}
export function decodeAntivirusResult(
  result: ScannerCommandResult,
): 'clean' | 'malware' | 'unsupported' {
  try {
    const value = decode(result, 4096);
    fields(value, ['protocol', 'engine', 'engineVersion', 'status']);
    if (
      value.protocol !== 'margin-av-inspection-v1' ||
      value.engine !== 'clamav' ||
      value.engineVersion !== ANTIVIRUS_VERSION ||
      !['clean', 'malware', 'unsupported'].includes(value.status as string) ||
      result.exitCode !== (value.status === 'clean' ? 0 : 10)
    )
      throw new Error();
    return value.status as 'clean' | 'malware' | 'unsupported';
  } catch {
    throw new ScannerUnavailableError();
  }
}
