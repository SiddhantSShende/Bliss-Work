import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import type { MailAttachmentDTO } from '@taskboard/shared';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { refreshSession } from '@taskboard/app/lib/refresh';
import { useSession } from '@taskboard/app/store/session';
import { MEDIA_MAX_BYTES, prettySize } from '@taskboard/app/chatEnvelope';
import { describeUploadError, fromDocumentAsset, validatePicked, type PickedFile } from '../lib/attachmentFiles';
import { uploadAttachmentNative } from '../lib/uploadAttachment';

export type MailAttachmentStatus = 'uploading' | 'ready' | 'failed';

/** One row of the composer's attachment tray. */
export interface MailAttachmentItem {
  key: string;
  name: string;
  mime: string;
  size?: number;
  /** Local file uri — present for files picked in this session, used for image thumbnails. */
  uri?: string;
  status: MailAttachmentStatus;
  /** 0..1 while uploading. */
  ratio: number;
  /** Server attachment id, set once the upload landed. */
  id?: string;
  error?: string;
}

/** Shown for any failed upload; the specific reason (if any) follows on its own line. */
export const UPLOAD_FAILED_MESSAGE = 'File upload failed. Please try again.';

let keySeq = 0;
const nextKey = () => `mail-up-${Date.now().toString(36)}-${(keySeq++).toString(36)}`;

/**
 * Attachments for the mail composer — mobile port of
 * packages/app/src/features/MailAttachments.tsx (same contract).
 *
 * Files go to the EXISTING attachment endpoint (`uploadAttachmentNative`, the
 * same uploader chat uses) under scope `mail`, scoped to the DRAFT id. They land
 * on the server as they are picked; `sendMail` then commits every file still
 * scoped to the draft, so Send itself stays a small JSON request. Uploads that
 * never get sent expire server-side, and discarding the draft drops them.
 *
 * Because Send commits everything on the draft, a row removed from the tray must
 * also be detached server-side (`removeDraftAttachment`) — `isBusy` covers the
 * window where an upload or a detach is still in flight so Send can wait for it.
 *
 * @param initial files ALREADY on the draft when one is resumed from Drafts; they
 *                must be shown, because Send ships them.
 */
export function useMailAttachments(mailId: string | undefined, initial?: MailAttachmentDTO[]) {
  const { api, config } = useRuntime();
  const [items, setItems] = useState<MailAttachmentItem[]>([]);
  const [removing, setRemoving] = useState(0);
  const filesRef = useRef(new Map<string, PickedFile>());
  const controllers = useRef(new Map<string, AbortController>());
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    if (!initial?.length) return;
    setItems((prev) => {
      const known = new Set(prev.map((i) => i.id).filter(Boolean));
      const seeded = initial
        .filter((a) => !known.has(a.id))
        .map(
          (a): MailAttachmentItem => ({
            key: `s${a.id}`,
            name: a.filename,
            mime: a.mime,
            size: a.sizeBytes,
            status: 'ready',
            ratio: 1,
            id: a.id,
          }),
        );
      return seeded.length ? [...prev, ...seeded] : prev;
    });
  }, [initial]);

  const patch = useCallback((key: string, change: Partial<MailAttachmentItem>) => {
    setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...change } : i)));
  }, []);

  const detach = useCallback(
    async (attachmentId: string) => {
      if (!mailId) return;
      await api.removeDraftAttachment(mailId, attachmentId);
    },
    [api, mailId],
  );

  const upload = useCallback(
    async (key: string) => {
      const file = filesRef.current.get(key);
      if (!file || !mailId || controllers.current.has(key)) return;
      const controller = new AbortController();
      controllers.current.set(key, controller);
      patch(key, { status: 'uploading', ratio: 0, error: undefined });
      let lastRatio = 0;
      try {
        const uploaded = await uploadAttachmentNative({
          baseUrl: config.messagingBase,
          scope: 'mail',
          scopeId: mailId,
          file,
          getToken: () => useSession.getState().accessToken,
          refreshToken: () =>
            refreshSession(config.authBase, config.persistToken, config.getRefreshToken).then((s) => s?.accessToken ?? null),
          onProgress: (loaded, total) => {
            const ratio = total > 0 ? loaded / total : 0;
            if (ratio - lastRatio >= 0.02 || ratio >= 1) {
              lastRatio = ratio;
              patch(key, { ratio });
            }
          },
          signal: controller.signal,
        });
        controllers.current.delete(key);
        if (controller.signal.aborted) {
          // remove() fired after the bytes reached the server: detach so it does not ship unseen.
          void detach(uploaded.id).catch(() => undefined);
          return;
        }
        // The SERVER's sniffed type and size, never the picker's guess.
        patch(key, { status: 'ready', ratio: 1, id: uploaded.id, mime: uploaded.mime, size: uploaded.sizeBytes });
      } catch (err) {
        controllers.current.delete(key);
        if (controller.signal.aborted) return; // removed while uploading — the row is already gone
        const reason = describeUploadError(err, 'upload');
        patch(key, { status: 'failed', error: `${UPLOAD_FAILED_MESSAGE}\n${reason}` });
      }
    },
    [config, mailId, patch, detach],
  );

  const enqueue = useCallback(
    (picked: PickedFile[]) => {
      if (picked.length === 0) return;
      const { accepted, rejected } = validatePicked(
        picked,
        { maxBytes: MEDIA_MAX_BYTES, maxFiles: Number.MAX_SAFE_INTEGER },
        prettySize,
      );
      if (rejected.length > 0) {
        Alert.alert(
          rejected.length === 1 ? "Can't attach this file" : "Can't attach some files",
          rejected
            .map((r) => `${r.name}: ${r.reason.startsWith('Larger') ? `File is too large. Maximum size is ${prettySize(MEDIA_MAX_BYTES)}.` : r.reason}`)
            .join('\n'),
        );
      }
      if (accepted.length === 0) return;
      const entries = accepted.map((file) => ({ key: nextKey(), file }));
      entries.forEach(({ key, file }) => filesRef.current.set(key, file));
      setItems((prev) => [
        ...prev,
        ...entries.map(
          ({ key, file }): MailAttachmentItem => ({
            key,
            name: file.name,
            mime: file.mime,
            size: file.size,
            uri: file.uri,
            status: 'uploading',
            ratio: 0,
          }),
        ),
      ]);
      entries.forEach(({ key }) => void upload(key));
    },
    [upload],
  );

  /** Native document picker — any file type (the backend sniffs and enforces its own rules). */
  const pick = useCallback(async () => {
    if (!mailId) return;
    try {
      const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true, type: '*/*' });
      if (result.canceled) return;
      enqueue((result.assets ?? []).map(fromDocumentAsset));
    } catch (err) {
      console.warn('[mail-attachments] document picker failed', err);
      Alert.alert("Couldn't open your files", 'Please try again.');
    }
  }, [mailId, enqueue]);

  /** Remove from the tray; a file that reached the server is also taken off the draft. */
  const remove = useCallback(
    (key: string) => {
      const item = itemsRef.current.find((i) => i.key === key);
      if (!item) return;
      controllers.current.get(key)?.abort();
      controllers.current.delete(key);
      filesRef.current.delete(key);
      setItems((prev) => prev.filter((i) => i.key !== key));
      if (!item.id) return;
      setRemoving((n) => n + 1);
      detach(item.id)
        .catch((err) => {
          // Still on the draft, so Send would ship it — put the row back instead of pretending.
          setItems((prev) => (prev.some((i) => i.key === key) ? prev : [...prev, item]));
          Alert.alert("Couldn't remove that file", describeUploadError(err, 'upload'));
        })
        .finally(() => setRemoving((n) => n - 1));
    },
    [detach],
  );

  const retry = useCallback((key: string) => void upload(key), [upload]);

  return useMemo(
    () => ({
      items,
      pick,
      remove,
      retry,
      /** An upload is in flight, or a removal has not reached the server — Send waits. */
      isBusy: removing > 0 || items.some((i) => i.status === 'uploading'),
      hasFailed: items.some((i) => i.status === 'failed'),
    }),
    [items, pick, remove, retry, removing],
  );
}
