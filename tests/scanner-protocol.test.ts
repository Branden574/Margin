import { expect, it } from 'vitest';
import {
  decodeAntivirusResult,
  decodeParserResult,
  PARSER_VERSION,
  ScannerUnavailableError,
} from '../apps/api/src/scanner/protocol';
const parser = {
  protocol: 'margin-pdf-inspection-v1',
  engine: 'qpdf-pdfjs',
  engineVersion: PARSER_VERSION,
  status: 'valid',
  reason: 'clean',
  pageCount: 1,
  pageGeometry: [{ index: 0, width: 612, height: 792 }],
};
const av = {
  protocol: 'margin-av-inspection-v1',
  engine: 'clamav',
  engineVersion: '1.4.6',
  status: 'clean',
};
const result = (value: unknown, exitCode = 0) => ({
  stdout: Buffer.from(JSON.stringify(value)),
  exitCode,
});
it('accepts exact valid parser geometry and antivirus verdict', () => {
  expect(decodeParserResult(result(parser))).toEqual({
    status: 'valid',
    pageCount: 1,
    pageGeometry: parser.pageGeometry,
  });
  expect(decodeAntivirusResult(result(av))).toBe('clean');
});
it.each(['unsupported', 'invalid_document'])(
  'accepts deterministic parser rejection %s',
  (reason) => {
    const { pageGeometry, ...rejected } = parser;
    expect(
      decodeParserResult(result({ ...rejected, status: 'rejected', reason, pageCount: 0 }, 10)),
    ).toEqual({ status: 'rejected', reason });
  },
);
it.each(['malware', 'unsupported'])('accepts classified antivirus rejection %s', (status) => {
  expect(decodeAntivirusResult(result({ ...av, status }, 10))).toBe(status);
});
it.each([
  { ...parser, engineVersion: 'fixture' },
  { ...parser, extra: 'private' },
  { ...parser, pageCount: 2 },
  { ...parser, pageGeometry: [{ index: 1, width: 612, height: 792 }] },
  { ...parser, pageGeometry: [{ index: 0, width: 100001, height: 792 }] },
  { ...parser, pageGeometry: [{ index: 0, width: 612, height: 792, text: 'private' }] },
  { ...parser, status: 'rejected', reason: 'resource_limit', pageCount: 0 },
])('keeps malformed, unsupported or unbounded parser outcomes quarantined %#', (value) => {
  expect(() => decodeParserResult(result(value))).toThrow(ScannerUnavailableError);
});
it('rejects exit/protocol mismatches, duplicate escaped keys, non-UTF8 and overlong output', () => {
  expect(() => decodeParserResult(result(parser, 10))).toThrow(ScannerUnavailableError);
  expect(() => decodeAntivirusResult(result({ ...av, status: 'malware' }, 0))).toThrow(
    ScannerUnavailableError,
  );
  expect(() => decodeAntivirusResult(result({ ...av, status: 'resource_limit' }, 10))).toThrow(
    ScannerUnavailableError,
  );
  expect(() => decodeAntivirusResult(result({ ...av, engineVersion: 'next' }))).toThrow(
    ScannerUnavailableError,
  );
  expect(() =>
    decodeAntivirusResult({
      stdout: Buffer.from(
        JSON.stringify(av).replace('"status":', '"st\\u0061tus":"malware","status":'),
      ),
      exitCode: 0,
    }),
  ).toThrow(ScannerUnavailableError);
  expect(() => decodeParserResult({ stdout: Buffer.from([0xff]), exitCode: 0 })).toThrow(
    ScannerUnavailableError,
  );
  expect(() => decodeParserResult({ stdout: Buffer.alloc(262145, 32), exitCode: 0 })).toThrow(
    ScannerUnavailableError,
  );
});
