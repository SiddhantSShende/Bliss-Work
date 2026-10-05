import { wireFileName } from './attachmentFiles';

/**
 * React Native multipart upload for chat attachments.
 *
 * WHY THIS EXISTS (root cause of "files are not sent from Chats"):
 * `ApiClient.uploadAttachment` (packages/shared/src/api/client.ts) is written
 * for browsers: it does `form.append('file', blob, filename)`. React Native's
 * FormData polyfill is not the web one:
 *   - `append(key, value)` takes two arguments — the filename is dropped;
 *   - `getParts()` spreads the value and only understands a `{ uri, name, type }`
 *     object. A Blob (what `fetch(file://…).blob()` yields) spreads to its
 *     private `_data`, so the part has neither `uri` nor `string` and
 *     NetworkingModule.constructMultipartBody fails with "Unrecognized FormData
 *     part." → XHR `onerror` → the caller sees "network error during upload",
 *     before the request is ever sent (Android; iOS behaves the same way).
 * So no file could ever be uploaded from the app, whatever its type or size.
 *
 * This follows the SAME wire contract as the shared client (POST
 * {messagingBase}/api/v1/attachments?scope=&scopeId=…, multipart field `file`,
 * `Authorization: Bearer`, single silent refresh-and-retry on 401, response is
 * an AttachmentDTO) but feeds React Native the `{ uri, name, type }` file
 * descriptor it actually understands, so the file is streamed from disk by the
 * native layer instead of being read into JS.
 */

/** `mail` scopes the file to a mail DRAFT id (see useMailAttachments). */
export type UploadScope = 'conversation' | 'channel' | 'thread' | 'mail';

export class UploadError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

export interface UploadedAttachment {
  id: string;
  filename: string;
  mime: string;
  sizeBytes: number;
}

export interface UploadParams {
  /** `config.messagingBase` — no trailing slash. */
  baseUrl: string;
  scope: UploadScope;
  scopeId: string;
  file: { uri: string; name: string; mime: string };
  width?: number;
  height?: number;
  durationMs?: number;
  getToken: () => string | null | undefined;
  /** Refresh the session; resolves the new access token or null. */
  refreshToken?: () => Promise<string | null>;
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
  /** Milliseconds; a hung radio must not spin forever. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export function buildUploadUrl(p: Pick<UploadParams, 'baseUrl' | 'scope' | 'scopeId' | 'width' | 'height' | 'durationMs'>): string {
  const qs = [`scope=${encodeURIComponent(p.scope)}`, `scopeId=${encodeURIComponent(p.scopeId)}`];
  if (p.width !== undefined) qs.push(`width=${Math.round(p.width)}`);
  if (p.height !== undefined) qs.push(`height=${Math.round(p.height)}`);
  if (p.durationMs !== undefined) qs.push(`durationMs=${Math.round(p.durationMs)}`);
  return `${p.baseUrl}/api/v1/attachments?${qs.join('&')}`;
}

/** The value React Native's FormData turns into a streamed file part. */
export function buildFilePart(file: UploadParams['file']): { uri: string; name: string; type: string } {
  return { uri: file.uri, name: wireFileName(file.name), type: file.mime };
}

function parseAttachment(body: unknown): UploadedAttachment | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.id !== 'string' || typeof b.mime !== 'string' || typeof b.sizeBytes !== 'number') return null;
  return {
    id: b.id,
    filename: typeof b.filename === 'string' ? b.filename : '',
    mime: b.mime,
    sizeBytes: b.sizeBytes,
  };
}

function sendOnce(p: UploadParams, token: string | null | undefined): Promise<{ status: number; body: unknown; text: string }> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    // React Native's `{ uri, name, type }` file descriptor (see header). The
    // web typings only know Blob, hence the cast.
    form.append('file', buildFilePart(p.file) as unknown as Blob);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', buildUploadUrl(p), true);
    xhr.timeout = p.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (token) xhr.setRequestHeader('authorization', `Bearer ${token}`);
    xhr.setRequestHeader('accept', 'application/json');
    // No content-type: the native layer writes multipart/form-data with the
    // boundary it generates.

    if (p.onProgress) {
      const onProgress = p.onProgress;
      xhr.upload.onprogress = (e: ProgressEvent) => {
        if (e.lengthComputable) onProgress(e.loaded, e.total);
      };
    }
    xhr.onload = () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(xhr.responseText);
      } catch {
        parsed = undefined;
      }
      resolve({ status: xhr.status, body: parsed, text: xhr.responseText });
    };
    xhr.onerror = () => reject(new UploadError(0, 'network error during upload'));
    xhr.ontimeout = () => reject(new UploadError(408, 'upload timed out'));
    xhr.onabort = () => reject(new UploadError(0, 'upload cancelled'));

    if (p.signal) {
      if (p.signal.aborted) {
        xhr.abort();
        return;
      }
      p.signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.send(form);
  });
}

/** Uploads one file; throws UploadError (status 0 = transport failure). */
export async function uploadAttachmentNative(p: UploadParams): Promise<UploadedAttachment> {
  const token = p.getToken();
  let res = await sendOnce(p, token);

  // Same single silent refresh-and-retry as ApiClient: an access token that
  // expired while the user was choosing the file must not lose the upload.
  if (res.status === 401 && token && p.refreshToken) {
    const fresh = await p.refreshToken().catch(() => null);
    if (fresh) res = await sendOnce(p, p.getToken() ?? fresh);
  }

  if (res.status < 200 || res.status >= 300) {
    const body = res.body as { error?: { message?: string; code?: string } } | undefined;
    throw new UploadError(res.status, body?.error?.message ?? (res.text ? res.text.slice(0, 200) : `upload failed (${res.status})`), body?.error?.code);
  }
  const parsed = parseAttachment(res.body);
  if (!parsed) throw new UploadError(502, 'invalid response from server');
  return parsed;
}
