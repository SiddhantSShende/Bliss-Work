/**
 * useMailAttachments — the composer's upload/remove tray state.
 *
 * Regression coverage for two related bugs found in one audit:
 *
 *   1. Removing a file WHILE it was still uploading only ever dropped it from
 *      local state — the in-flight XMLHttpRequest kept running unabated and
 *      completed on the server anyway, still scoped to the draft. The row
 *      the sender believed they'd removed shipped with the mail regardless.
 *      Fixed by giving every upload an AbortController that remove() aborts,
 *      plus a fallback: if the abort loses the race against an already-
 *      completed request, the resulting attachment is detached immediately
 *      instead of being left dangling on the draft.
 *
 *   2. remove() on an ALREADY-uploaded file fired its detach request without
 *      any way for the caller to know a removal was still in flight, so
 *      clicking Send right after Remove could beat the detach to the server
 *      and ship the "removed" file anyway. Fixed by exposing `isRemoving`,
 *      which MailCompose's canSend now waits on the same way it waits on
 *      isUploading.
 */
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { AttachmentDTO } from "@taskboard/shared";
import { useMailAttachments } from "./MailAttachments";

const h = vi.hoisted(() => ({
  uploadAttachment: vi.fn(),
  removeDraftAttachment: vi.fn(async (): Promise<void> => undefined),
}));

vi.mock("../lib/runtime", () => ({
  useRuntime: () => ({
    api: {
      uploadAttachment: h.uploadAttachment,
      removeDraftAttachment: h.removeDraftAttachment,
    },
    config: {},
  }),
}));

function dto(over: Partial<AttachmentDTO> & { id: string }): AttachmentDTO {
  return { filename: "file.pdf", mime: "application/pdf", sizeBytes: 1024, ...over } as AttachmentDTO;
}

function file(name = "deck.pdf"): File {
  return new File(["x"], name, { type: "application/pdf" });
}

/** A controllable upload: resolves/rejects only when the test says so, and
 *  records whether its signal was aborted.
 *
 *  `rejectOnAbort` mirrors the real XHR wrapper's behaviour when the abort
 *  actually reaches the in-flight request in time. Passing `false` simulates
 *  the race this fix also has to cover: abort() is called, but the
 *  underlying request had already completed, so the promise still resolves
 *  with a real attachment despite the signal reading `aborted`. */
function deferredUpload(rejectOnAbort: boolean) {
  let resolve!: (v: AttachmentDTO) => void;
  let reject!: (e: unknown) => void;
  let signal: AbortSignal | undefined;
  const promise = new Promise<AttachmentDTO>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  h.uploadAttachment.mockImplementationOnce(
    async (_scope: string, _id: string, _file: File, opts: { signal?: AbortSignal }) => {
      signal = opts.signal;
      if (rejectOnAbort) {
        signal?.addEventListener("abort", () => reject(new Error("upload cancelled")));
      }
      return promise;
    },
  );
  return {
    resolve,
    signalWasAborted: () => signal?.aborted ?? false,
  };
}

describe("useMailAttachments", () => {
  it("aborts the upload when a file is removed mid-upload, and never detaches (nothing to detach yet)", async () => {
    h.uploadAttachment.mockClear();
    h.removeDraftAttachment.mockClear();
    const upload = deferredUpload(true);
    const { result } = renderHook(() => useMailAttachments("mail-1"));

    act(() => {
      result.current.inputProps.onChange({
        target: { files: [file()], value: "" },
      } as unknown as React.ChangeEvent<HTMLInputElement>);
    });
    await waitFor(() => expect(result.current.files).toHaveLength(1));
    const key = result.current.files[0]!.key;

    act(() => result.current.remove(key));

    expect(result.current.files).toHaveLength(0);
    await waitFor(() => expect(upload.signalWasAborted()).toBe(true));
    // No server id was ever assigned, so there is nothing to send a detach
    // request for — the abort above is what stops the file from landing.
    expect(h.removeDraftAttachment).not.toHaveBeenCalled();
  });

  it("detaches an upload that finished anyway after losing the abort race", async () => {
    h.uploadAttachment.mockClear();
    h.removeDraftAttachment.mockClear();
    const upload = deferredUpload(false);
    const { result } = renderHook(() => useMailAttachments("mail-1"));

    act(() => {
      result.current.inputProps.onChange({
        target: { files: [file()], value: "" },
      } as unknown as React.ChangeEvent<HTMLInputElement>);
    });
    await waitFor(() => expect(result.current.files).toHaveLength(1));
    const key = result.current.files[0]!.key;

    // Removed, but the "request" resolves successfully anyway — simulating
    // the XHR having already completed server-side before abort() landed.
    act(() => result.current.remove(key));
    act(() => upload.resolve(dto({ id: "att-1" })));

    await waitFor(() =>
      expect(h.removeDraftAttachment).toHaveBeenCalledWith("mail-1", "att-1"),
    );
    expect(result.current.files).toHaveLength(0);
  });

  it("isRemoving is true while an already-uploaded file's detach is in flight, false once it resolves", async () => {
    h.uploadAttachment.mockClear();
    h.removeDraftAttachment.mockClear();
    let resolveDetach!: () => void;
    h.removeDraftAttachment.mockImplementationOnce(
      () => new Promise<void>((res) => (resolveDetach = res)),
    );
    h.uploadAttachment.mockResolvedValueOnce(dto({ id: "att-1" }));
    const { result } = renderHook(() => useMailAttachments("mail-1"));

    act(() => {
      result.current.inputProps.onChange({
        target: { files: [file()], value: "" },
      } as unknown as React.ChangeEvent<HTMLInputElement>);
    });
    await waitFor(() => expect(result.current.files[0]?.id).toBe("att-1"));
    const key = result.current.files[0]!.key;

    act(() => result.current.remove(key));
    expect(result.current.isRemoving).toBe(true);

    await act(async () => {
      resolveDetach();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.isRemoving).toBe(false));
  });

  it("an already-uploaded file's remove() still detaches it exactly as before", async () => {
    h.uploadAttachment.mockClear();
    h.removeDraftAttachment.mockClear();
    h.uploadAttachment.mockResolvedValueOnce(dto({ id: "att-2" }));
    const { result } = renderHook(() => useMailAttachments("mail-1"));

    act(() => {
      result.current.inputProps.onChange({
        target: { files: [file()], value: "" },
      } as unknown as React.ChangeEvent<HTMLInputElement>);
    });
    await waitFor(() => expect(result.current.files[0]?.id).toBe("att-2"));
    const key = result.current.files[0]!.key;

    act(() => result.current.remove(key));

    expect(result.current.files).toHaveLength(0);
    await waitFor(() =>
      expect(h.removeDraftAttachment).toHaveBeenCalledWith("mail-1", "att-2"),
    );
  });
});
