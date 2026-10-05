import {
  describeUploadError,
  ensureFileName,
  extensionOf,
  fromDocumentAsset,
  fromImageAsset,
  normalizeMime,
  resolveMime,
  validatePicked,
  wireFileName,
} from '../attachmentFiles';

const fmt = (n: number) => `${n}B`;

describe('resolveMime', () => {
  it('trusts a specific picker type', () => {
    expect(resolveMime('a.bin', 'Application/PDF; charset=x')).toBe('application/pdf');
  });
  it.each([
    ['report.pdf', 'application/pdf'],
    ['a.DOCX', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['a.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['a.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['a.txt', 'text/plain'],
    ['a.zip', 'application/zip'],
    ['a.jpeg', 'image/jpeg'],
    ['a.mov', 'video/quicktime'],
    ['a.m4a', 'audio/mp4'],
  ])('falls back to the extension for %s when the picker gives nothing', (name, mime) => {
    expect(resolveMime(name, undefined)).toBe(mime);
    expect(resolveMime(name, 'application/octet-stream')).toBe(mime);
    expect(resolveMime(name, '*/*')).toBe(mime);
  });
  it('always yields a valid header value', () => {
    expect(resolveMime('mystery', null)).toBe('application/octet-stream');
    expect(resolveMime('mystery.zzz', 'garbage')).toBe('application/octet-stream');
  });
});

describe('names', () => {
  it('extensionOf', () => {
    expect(extensionOf('a/b/c.TAR')).toBe('tar');
    expect(extensionOf('.hidden')).toBe('');
    expect(extensionOf('noext')).toBe('');
    expect(extensionOf('trailing.')).toBe('');
  });
  it('normalizeMime', () => {
    expect(normalizeMime(' IMAGE/PNG ')).toBe('image/png');
    expect(normalizeMime('nope')).toBe('');
    expect(normalizeMime(undefined)).toBe('');
  });
  it('ensureFileName derives a name when the picker has none', () => {
    expect(ensureFileName('  ', 'file:///cache/My%20Doc.pdf', 'application/pdf')).toBe('My Doc.pdf');
    expect(ensureFileName(undefined, 'content://x/', 'image/jpeg')).toBe('file.jpg');
    expect(ensureFileName('a.txt', 'file:///x', 'text/plain')).toBe('a.txt');
  });
  it('wireFileName strips characters RN would percent-encode but keeps the extension', () => {
    expect(wireFileName('Q3 Report (final).pdf')).toBe('Q3_Report_final.pdf');
    expect(wireFileName('résumé.docx')).toBe('resume.docx');
    expect(wireFileName('日本語.xlsx')).toBe('file.xlsx');
    expect(wireFileName('...')).toBe('file');
    expect(wireFileName('a'.repeat(300) + '.pdf').length).toBeLessThanOrEqual(112);
  });
});

describe('asset adapters', () => {
  it('fromDocumentAsset resolves mime and drops unknown sizes', () => {
    expect(fromDocumentAsset({ uri: 'file:///c/a.xlsx', name: 'a.xlsx', mimeType: undefined, size: undefined })).toEqual({
      uri: 'file:///c/a.xlsx',
      name: 'a.xlsx',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: undefined,
    });
  });
  it('fromImageAsset carries dimensions and video duration', () => {
    const v = fromImageAsset({ uri: 'file:///c/x.mp4', type: 'video', width: 1080.4, height: 1920, duration: 5000, fileSize: 10 });
    expect(v).toMatchObject({ mime: 'video/mp4', width: 1080, height: 1920, durationMs: 5000, size: 10 });
    const i = fromImageAsset({ uri: 'file:///c/x', type: 'image', duration: 9 });
    expect(i.mime).toBe('image/jpeg');
    expect(i.durationMs).toBeUndefined();
  });
});

describe('validatePicked', () => {
  const limits = { maxBytes: 100, maxFiles: 2 };
  const f = (name: string, size?: number) => ({ uri: 'file:///' + name, name, mime: 'text/plain', size });
  it('refuses too many files as a whole', () => {
    expect(validatePicked([f('a', 1), f('b', 1), f('c', 1)], limits, fmt).fatal).toMatch(/up to 2/);
  });
  it('rejects empty and oversize, keeps unknown size', () => {
    const r = validatePicked([f('e', 0), f('big', 101), f('ok', 100), f('unk')], { ...limits, maxFiles: 10 }, fmt);
    expect(r.rejected.map((x) => x.name)).toEqual(['e', 'big']);
    expect(r.accepted.map((x) => x.name)).toEqual(['ok', 'unk']);
  });
});

describe('describeUploadError', () => {
  it.each([
    [{ status: 0, message: 'network error during upload' }, /No connection/],
    [{ status: 401, message: 'x' }, /session expired/],
    [{ status: 403, message: 'x' }, /permission/],
    [{ status: 413, message: 'file exceeds the maximum upload size' }, /larger than the server allows/],
    [{ status: 413, message: 'daily upload limit reached for this workspace' }, /daily upload limit/],
    [{ status: 408, message: 'x' }, /timed out/],
    [{ status: 502, message: '<html>' }, /server had a problem/],
    [{ status: 400, message: "missing 'file' part" }, /rejected the file: missing/],
  ])('maps %j', (err, re) => {
    expect(describeUploadError(err)).toMatch(re);
  });
  it('prefixes send-stage failures so the user knows the file did upload', () => {
    expect(describeUploadError({ status: 0, message: 'x' }, 'send')).toMatch(/^Uploaded, but the message was not sent/);
  });
  it('handles plain errors and junk', () => {
    expect(describeUploadError(new Error('boom'))).toBe('boom');
    expect(describeUploadError(new Error('Network request failed'))).toMatch(/No connection/);
    expect(describeUploadError(undefined)).toBe('Upload failed.');
  });
});
