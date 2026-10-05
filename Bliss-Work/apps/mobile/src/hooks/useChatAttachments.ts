import { useCallback, useRef, useState } from 'react';
import { Alert } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { refreshSession } from '@taskboard/app/lib/refresh';
import { useSession } from '@taskboard/app/store/session';
import { MEDIA_MAX_BYTES, MEDIA_MAX_FILES, encodeMedia, prettySize, type MediaItem } from '@taskboard/app/chatEnvelope';
import {
  describeUploadError,
  fromDocumentAsset,
  fromImageAsset,
  validatePicked,
  type PickedFile,
} from '../lib/attachmentFiles';
import { uploadAttachmentNative, type UploadScope } from '../lib/uploadAttachment';

export type UploadStatus = 'uploading' | 'sending' | 'failed';

/** What the strip above the composer renders for one file. */
export interface UploadItem {
  key: string;
  name: string;
  size?: number;
  status: UploadStatus;
  /** 0..1 while uploading. */
  ratio: number;
  error?: string;
}

let keySeq = 0;
const nextKey = () => `up-${Date.now().toString(36)}-${(keySeq++).toString(36)}`;

/**
 * Native file/photo picker → upload → one media message, for one conversation
 * or channel.
 *
 * Order (mirrors packages/app/src/features/useChatMedia.tsx): upload every
 * file, send ONE message carrying the resulting attachment ids, then commit.
 * Committing only after the message was accepted is what lets an abandoned
 * pick self-clean (uploads lapse in 24h uncommitted).
 *
 * Honesty rules: a file leaves the strip only after the server confirmed the
 * upload AND the message send resolved. Any failure leaves a visible failed
 * row with the reason and a Retry that resumes from where it broke (a file
 * that already uploaded is not uploaded again, only the send is retried).
 * The upload itself is `uploadAttachmentNative` — see its header for why the
 * shared `ApiClient.uploadAttachment` cannot work on React Native.
 */
export function useChatAttachments(
  scopeId: string,
  sendBody: (body: string) => Promise<unknown>,
  scope: UploadScope = 'conversation',
) {
  const { api, config } = useRuntime();
  const [uploads, setUploads] = useState<UploadItem[]>([]);

  // Latest sendBody without re-creating every callback on each render (the
  // screens pass a fresh arrow each time).
  const sendRef = useRef(sendBody);
  sendRef.current = sendBody;
  const filesRef = useRef(new Map<string, PickedFile>());
  const mediaRef = useRef(new Map<string, MediaItem>());
  const busyKeys = useRef(new Set<string>());

  const patch = useCallback((keys: string[], change: Partial<UploadItem>) => {
    setUploads((prev) => prev.map((u) => (keys.includes(u.key) ? { ...u, ...change } : u)));
  }, []);

  const forget = useCallback((keys: string[]) => {
    for (const k of keys) {
      filesRef.current.delete(k);
      mediaRef.current.delete(k);
      busyKeys.current.delete(k);
    }
    setUploads((prev) => prev.filter((u) => !keys.includes(u.key)));
  }, []);

  /** Commit with retries: a lost commit would let a SENT file lapse in 24h. */
  const commit = useCallback(
    async (id: string) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await api.commitAttachment(id);
          return;
        } catch (err) {
          if (attempt === 2) console.warn('[chat-attachments] commit failed', id, err);
          else await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        }
      }
    },
    [api],
  );

  const run = useCallback(
    async (keys: string[]) => {
      const todo = keys.filter((k) => filesRef.current.has(k) && !busyKeys.current.has(k));
      if (todo.length === 0) return;
      todo.forEach((k) => busyKeys.current.add(k));

      const needsUpload = todo.filter((k) => !mediaRef.current.has(k));
      patch(needsUpload, { status: 'uploading', ratio: 0, error: undefined });

      await Promise.all(
        needsUpload.map(async (key) => {
          const file = filesRef.current.get(key)!;
          let lastRatio = 0;
          try {
            const uploaded = await uploadAttachmentNative({
              baseUrl: config.messagingBase,
              scope,
              scopeId,
              file,
              width: file.width,
              height: file.height,
              durationMs: file.durationMs,
              getToken: () => useSession.getState().accessToken,
              refreshToken: () =>
                refreshSession(config.authBase, config.persistToken, config.getRefreshToken).then(
                  (s) => s?.accessToken ?? null,
                ),
              onProgress: (loaded, total) => {
                const ratio = total > 0 ? loaded / total : 0;
                if (ratio - lastRatio >= 0.02 || ratio >= 1) {
                  lastRatio = ratio;
                  patch([key], { ratio });
                }
              },
            });
            mediaRef.current.set(key, {
              id: uploaded.id,
              name: file.name,
              size: uploaded.sizeBytes,
              // The SERVER's sniffed type, never the picker's guess.
              mime: uploaded.mime,
              width: file.width,
              height: file.height,
              durationMs: file.durationMs,
            });
          } catch (err) {
            busyKeys.current.delete(key);
            patch([key], { status: 'failed', error: describeUploadError(err, 'upload') });
          }
        }),
      );

      const ready = todo.filter((k) => mediaRef.current.has(k));
      if (ready.length === 0) return;
      patch(ready, { status: 'sending', ratio: 1, error: undefined });
      const items = ready.map((k) => mediaRef.current.get(k)!);
      try {
        await sendRef.current(encodeMedia(items));
      } catch (err) {
        ready.forEach((k) => busyKeys.current.delete(k));
        patch(ready, { status: 'failed', error: describeUploadError(err, 'send') });
        return;
      }
      forget(ready);
      // Not awaited: the message is already delivered; commit only pins the file.
      items.forEach((it) => void commit(it.id));
    },
    [config, scope, scopeId, patch, forget, commit],
  );

  const enqueue = useCallback(
    (picked: PickedFile[]) => {
      if (picked.length === 0) return;
      const { accepted, rejected, fatal } = validatePicked(
        picked,
        { maxBytes: MEDIA_MAX_BYTES, maxFiles: MEDIA_MAX_FILES },
        prettySize,
      );
      if (fatal) {
        Alert.alert('Too many files', fatal);
        return;
      }
      if (rejected.length > 0) {
        Alert.alert(
          rejected.length === 1 ? "Can't send this file" : "Can't send some files",
          rejected.map((r) => `${r.name}: ${r.reason}`).join('\n'),
        );
      }
      if (accepted.length === 0) return;

      const entries = accepted.map((file) => ({ key: nextKey(), file }));
      entries.forEach(({ key, file }) => filesRef.current.set(key, file));
      setUploads((prev) => [
        ...prev,
        ...entries.map(({ key, file }): UploadItem => ({ key, name: file.name, size: file.size, status: 'uploading', ratio: 0 })),
      ]);
      void run(entries.map((e) => e.key));
    },
    [run],
  );

  /** Documents of any kind (PDF, Office, text, zip, audio, …). */
  const pickFiles = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        multiple: true,
        copyToCacheDirectory: true,
        type: '*/*',
      });
      if (result.canceled) return;
      enqueue((result.assets ?? []).map(fromDocumentAsset));
    } catch (err) {
      console.warn('[chat-attachments] document picker failed', err);
      Alert.alert("Couldn't open your files", 'Please try again.');
    }
  }, [enqueue]);

  /** Photos and videos from the library. */
  const pickMedia = useCallback(async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images', 'videos'],
        allowsMultipleSelection: true,
        selectionLimit: MEDIA_MAX_FILES,
        quality: 1,
      });
      if (result.canceled) return;
      enqueue((result.assets ?? []).map(fromImageAsset));
    } catch (err) {
      console.warn('[chat-attachments] image picker failed', err);
      Alert.alert("Couldn't open your photos", 'Allow photo access in your device Settings, then try again.');
    }
  }, [enqueue]);

  const retry = useCallback(
    (key: string) => {
      const failed = uploads.filter((u) => u.status === 'failed').map((u) => u.key);
      // Retrying one failed row also retries its failed siblings that share the
      // send stage, so they still go out as one message.
      const sameStage = (k: string) => mediaRef.current.has(k) === mediaRef.current.has(key);
      void run(failed.filter((k) => k === key || sameStage(k)));
    },
    [uploads, run],
  );

  const dismiss = useCallback((key: string) => forget([key]), [forget]);

  const busy = uploads.some((u) => u.status !== 'failed');

  return { pickFiles, pickMedia, uploads, retry, dismiss, busy };
}
