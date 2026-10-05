/**
 * Pure helpers for chat file attachments (no React Native imports, so they run
 * under plain jest): mime resolution, filename hygiene, size/count validation
 * and mapping upload failures to messages a person can act on.
 *
 * Why the mime work exists at all: on React Native a multipart file part is
 * only valid when it carries a Content-Type header (NetworkingModule.kt throws
 * "Binary FormData part needs a content-type header." otherwise), and the
 * picker's `mimeType` is optional — Android document providers frequently
 * return nothing or `application/octet-stream` for Office files. The backend
 * sniffs the real type from the bytes and never trusts the declared one, so
 * this is about producing a VALID request, not about security.
 */

export const OCTET_STREAM = 'application/octet-stream';

const MIME_BY_EXT: Record<string, string> = {
  // documents
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  // archives
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  // images
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  // video
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  '3gp': 'video/3gpp',
  // audio
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  amr: 'audio/amr',
  caf: 'audio/x-caf',
};

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'application/pdf': 'pdf',
};

/** Lowercased extension without the dot, or '' when there isn't one. */
export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

/** `Image/JPEG; charset=x` → `image/jpeg`; junk → ''. */
export function normalizeMime(raw: string | null | undefined): string {
  if (!raw) return '';
  const base = raw.split(';')[0]?.trim().toLowerCase() ?? '';
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+*-]+$/.test(base) ? base : '';
}

/**
 * The type to DECLARE for a picked file. The picker's type wins unless it is
 * missing or generic (`octet-stream`, wildcard), in which case the filename
 * extension decides; if that is unknown too, octet-stream (always a valid
 * header, and the server sniffs the bytes anyway).
 */
export function resolveMime(name: string, pickerMime?: string | null): string {
  const declared = normalizeMime(pickerMime);
  if (declared && declared !== OCTET_STREAM && !declared.endsWith('/*')) return declared;
  return MIME_BY_EXT[extensionOf(name)] ?? OCTET_STREAM;
}

/** Last path segment of a uri, percent-decoded, query stripped. */
function nameFromUri(uri: string): string {
  const path = uri.split(/[?#]/)[0] ?? '';
  const last = path.split('/').pop() ?? '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** A display name that is never empty and always carries a sensible extension. */
export function ensureFileName(name: string | null | undefined, uri: string, mime: string): string {
  const trimmed = (name ?? '').trim();
  if (trimmed) return trimmed;
  const fromUri = nameFromUri(uri).trim();
  if (fromUri) return fromUri;
  const ext = EXT_BY_MIME[mime];
  return ext ? `file.${ext}` : 'file';
}

/**
 * The filename put on the multipart part. React Native percent-encodes the
 * whole name (FormData.getParts → encodeURIComponent) and the server stores
 * the header verbatim, so "Q3 Report (final).pdf" would be saved as
 * "Q3%20Report%20(final).pdf". Restricting the wire name to a URL-safe ASCII
 * subset keeps the stored/downloaded name readable; the original name is still
 * what the chat message displays (it travels in the message body).
 */
export function wireFileName(name: string): string {
  const ext = extensionOf(name);
  const stem = name.replace(/\.[^.]*$/, '') || 'file';
  const clean = (s: string) =>
    s
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/^[._]+|_+$/g, '');
  const safeStem = (clean(stem) || 'file').slice(0, 100);
  const safeExt = clean(ext).slice(0, 12);
  return safeExt ? `${safeStem}.${safeExt}` : safeStem;
}

export interface PickedFile {
  uri: string;
  /** Display name (shown in the message). */
  name: string;
  /** Declared type — always a valid `type/subtype`. */
  mime: string;
  /** Bytes, when the picker reported it. */
  size?: number;
  width?: number;
  height?: number;
  durationMs?: number;
}

export interface DocumentAssetLike {
  uri: string;
  name?: string | null;
  mimeType?: string | null;
  size?: number | null;
}

export function fromDocumentAsset(a: DocumentAssetLike): PickedFile {
  const mime = resolveMime(a.name ?? nameFromUri(a.uri), a.mimeType);
  return {
    uri: a.uri,
    name: ensureFileName(a.name, a.uri, mime),
    mime,
    size: typeof a.size === 'number' && a.size >= 0 ? a.size : undefined,
  };
}

export interface ImageAssetLike {
  uri: string;
  fileName?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
  width?: number | null;
  height?: number | null;
  /** Milliseconds, videos only. */
  duration?: number | null;
  type?: string | null;
}

export function fromImageAsset(a: ImageAssetLike): PickedFile {
  const fallbackMime = a.mimeType || (a.type === 'video' ? 'video/mp4' : a.type === 'image' ? 'image/jpeg' : undefined);
  const mime = resolveMime(a.fileName ?? nameFromUri(a.uri), fallbackMime);
  const positive = (n: number | null | undefined) => (typeof n === 'number' && n > 0 ? Math.round(n) : undefined);
  return {
    uri: a.uri,
    name: ensureFileName(a.fileName, a.uri, mime),
    mime,
    size: typeof a.fileSize === 'number' && a.fileSize >= 0 ? a.fileSize : undefined,
    width: positive(a.width),
    height: positive(a.height),
    durationMs: a.type === 'video' ? positive(a.duration) : undefined,
  };
}

export interface Rejection {
  name: string;
  reason: string;
}

export interface Validation {
  accepted: PickedFile[];
  rejected: Rejection[];
  /** Set when the whole selection is refused (too many files). */
  fatal?: string;
}

/**
 * Cheap client-side checks before any bytes move. A file whose size the
 * picker did not report is ACCEPTED here — the server enforces the cap (413)
 * and the failure surfaces per file — rather than being silently dropped or
 * treated as 0 bytes.
 */
export function validatePicked(
  files: PickedFile[],
  limits: { maxBytes: number; maxFiles: number },
  formatBytes: (n: number) => string,
): Validation {
  if (files.length > limits.maxFiles) {
    return { accepted: [], rejected: [], fatal: `You can send up to ${limits.maxFiles} files at a time.` };
  }
  const accepted: PickedFile[] = [];
  const rejected: Rejection[] = [];
  for (const f of files) {
    if (f.size === 0) {
      rejected.push({ name: f.name, reason: 'The file is empty.' });
    } else if (f.size !== undefined && f.size > limits.maxBytes) {
      rejected.push({ name: f.name, reason: `Larger than ${formatBytes(limits.maxBytes)}.` });
    } else {
      accepted.push(f);
    }
  }
  return { accepted, rejected };
}

/** Anything carrying an HTTP-ish `status` — ApiError from shared, or ours. */
interface StatusError {
  status?: unknown;
  message?: unknown;
  code?: unknown;
}

/**
 * Turns an upload/send failure into one sentence for the person holding the
 * phone. `stage` matters only for wording: an upload failure means nothing was
 * sent; a send failure means the file is uploaded but the message did not go.
 */
export function describeUploadError(err: unknown, stage: 'upload' | 'send' = 'upload'): string {
  const e = (err && typeof err === 'object' ? err : {}) as StatusError;
  const status = typeof e.status === 'number' ? e.status : undefined;
  const raw = typeof e.message === 'string' ? e.message : err instanceof Error ? err.message : '';
  const prefix = stage === 'send' ? 'Uploaded, but the message was not sent. ' : '';

  if (status === 0 || (status === undefined && /network|failed to fetch|timeout|abort/i.test(raw))) {
    return `${prefix}No connection to the server. Check your internet and try again.`;
  }
  switch (status) {
    case 401:
      return `${prefix}Your session expired. Sign in again to send files.`;
    case 403:
      return `${prefix}You don't have permission to send files in this chat.`;
    case 404:
      return `${prefix}This chat is no longer available.`;
    case 408:
      return `${prefix}The upload timed out. Try again on a stronger connection.`;
    case 413:
      return /daily/i.test(raw)
        ? 'Your workspace has reached its daily upload limit. Try again tomorrow.'
        : 'The file is larger than the server allows.';
    case 429:
      return `${prefix}Too many requests. Wait a moment and try again.`;
    default:
      break;
  }
  if (status !== undefined && status >= 500) return `${prefix}The server had a problem. Try again in a moment.`;
  if (status === 400 || status === 422) {
    return `${prefix}The server rejected the file${raw ? `: ${raw}` : '.'}`;
  }
  return `${prefix}${raw || (stage === 'send' ? 'The message could not be sent.' : 'Upload failed.')}`;
}
