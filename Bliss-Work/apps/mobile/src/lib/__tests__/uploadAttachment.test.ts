import { buildFilePart, buildUploadUrl, uploadAttachmentNative, UploadError } from '../uploadAttachment';

type Reply = { status: number; body: string } | 'error';

/** Minimal XHR double that records what the request looked like on the wire. */
function installFakes(replies: Reply[]) {
  const sent: { url: string; headers: Record<string, string>; form: { parts: [string, unknown][] } }[] = [];
  class FakeForm {
    parts: [string, unknown][] = [];
    append(k: string, v: unknown) {
      this.parts.push([k, v]);
    }
  }
  class FakeXhr {
    static instances = 0;
    status = 0;
    responseText = '';
    timeout = 0;
    headers: Record<string, string> = {};
    url = '';
    upload: { onprogress?: unknown } = {};
    onload?: () => void;
    onerror?: () => void;
    ontimeout?: () => void;
    onabort?: () => void;
    open(_m: string, url: string) {
      this.url = url;
    }
    setRequestHeader(k: string, v: string) {
      this.headers[k.toLowerCase()] = v;
    }
    abort() {
      this.onabort?.();
    }
    send(form: FakeForm) {
      sent.push({ url: this.url, headers: this.headers, form });
      const r = replies.shift()!;
      queueMicrotask(() => {
        if (r === 'error') return this.onerror?.();
        this.status = r.status;
        this.responseText = r.body;
        this.onload?.();
      });
    }
  }
  (globalThis as any).FormData = FakeForm;
  (globalThis as any).XMLHttpRequest = FakeXhr;
  return sent;
}

const OK = JSON.stringify({ id: '11111111-1111-4111-8111-111111111111', filename: 'a.pdf', mime: 'application/pdf', sizeBytes: 5 });
const base = {
  baseUrl: 'https://m.example',
  scope: 'conversation' as const,
  scopeId: 'sid',
  file: { uri: 'file:///cache/My Doc.pdf', name: 'My Doc.pdf', mime: 'application/pdf' },
};

describe('uploadAttachmentNative', () => {
  it('scopes mail attachments to the draft id on the same endpoint', () => {
    expect(buildUploadUrl({ baseUrl: 'https://m.example', scope: 'mail', scopeId: 'draft-1' })).toBe(
      'https://m.example/api/v1/attachments?scope=mail&scopeId=draft-1',
    );
  });

  it('builds the same URL contract as the shared client', () => {
    expect(buildUploadUrl({ ...base, width: 10.6, durationMs: 5 })).toBe(
      'https://m.example/api/v1/attachments?scope=conversation&scopeId=sid&width=11&durationMs=5',
    );
  });

  it('sends a React Native file descriptor (uri/name/type), never a Blob', async () => {
    const sent = installFakes([{ status: 201, body: OK }]);
    const res = await uploadAttachmentNative({ ...base, getToken: () => 'tok' });
    expect(res).toMatchObject({ id: expect.any(String), mime: 'application/pdf', sizeBytes: 5 });
    expect(sent[0]!.headers.authorization).toBe('Bearer tok');
    expect(sent[0]!.headers['content-type']).toBeUndefined();
    expect(sent[0]!.form.parts).toEqual([['file', { uri: 'file:///cache/My Doc.pdf', name: 'My_Doc.pdf', type: 'application/pdf' }]]);
    expect(buildFilePart(base.file).type).toBe('application/pdf');
  });

  it('refreshes once on 401 and retries with the new token', async () => {
    const sent = installFakes([{ status: 401, body: '{}' }, { status: 201, body: OK }]);
    let token = 'old';
    const refreshToken = jest.fn(async () => {
      token = 'new';
      return 'new';
    });
    await uploadAttachmentNative({ ...base, getToken: () => token, refreshToken });
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(sent.map((s) => s.headers.authorization)).toEqual(['Bearer old', 'Bearer new']);
  });

  it('surfaces a failed refresh as the original 401', async () => {
    installFakes([{ status: 401, body: '{"error":{"message":"expired"}}' }]);
    await expect(
      uploadAttachmentNative({ ...base, getToken: () => 't', refreshToken: async () => null }),
    ).rejects.toMatchObject({ status: 401, message: 'expired' });
  });

  it('maps transport failure to status 0 and server errors to their status', async () => {
    installFakes(['error']);
    await expect(uploadAttachmentNative({ ...base, getToken: () => 't' })).rejects.toBeInstanceOf(UploadError);
    installFakes([{ status: 413, body: '{"error":{"message":"file exceeds the maximum upload size","code":"PAYLOAD_TOO_LARGE"}}' }]);
    await expect(uploadAttachmentNative({ ...base, getToken: () => 't' })).rejects.toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' });
  });

  it('rejects a 2xx with an unusable body instead of pretending success', async () => {
    installFakes([{ status: 201, body: '{"nope":1}' }]);
    await expect(uploadAttachmentNative({ ...base, getToken: () => 't' })).rejects.toMatchObject({ status: 502 });
  });
});
