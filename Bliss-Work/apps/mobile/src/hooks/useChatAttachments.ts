import { useCallback, useState } from 'react';
import { Alert } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { MEDIA_MAX_BYTES, MEDIA_MAX_FILES, encodeMedia, prettySize, type MediaItem } from '@taskboard/app/chatEnvelope';

type UploadOutcome = { ok: true; item: MediaItem } | { ok: false; name: string; message: string };

/**
 * Native file picker → upload → one media message, for one conversation.
 *
 * Mirrors the upload/commit order documented in packages/app/src/features/
 * useChatMedia.tsx (the web equivalent): upload first, send ONE message
 * carrying the resulting attachment ids, then commit — committing only after
 * the message actually sent is what lets an abandoned pick self-clean
 * (uploads lapse in 24h uncommitted). There is no staging tray here: picking
 * a file on mobile is a single deliberate action, so it uploads and sends in
 * one step instead of waiting for a separate Send tap.
 */
export function useChatAttachments(conversationId: string, sendBody: (body: string) => Promise<unknown>) {
  const { api } = useRuntime();
  const [sending, setSending] = useState(false);

  const pickAndSend = useCallback(async () => {
    const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
    if (result.canceled) return;
    const assets = result.assets ?? [];
    if (assets.length === 0) return;

    if (assets.length > MEDIA_MAX_FILES) {
      Alert.alert('Too many files', `You can send up to ${MEDIA_MAX_FILES} files at a time.`);
      return;
    }

    const uploadable = assets.filter((a) => (a.size ?? 0) <= MEDIA_MAX_BYTES);
    const oversized = assets.filter((a) => (a.size ?? 0) > MEDIA_MAX_BYTES);
    if (oversized.length > 0) {
      Alert.alert(
        'File too large',
        `${oversized.map((a) => a.name).join(', ')} ${oversized.length === 1 ? 'is' : 'are'} larger than ${prettySize(MEDIA_MAX_BYTES)} and will be skipped.`,
      );
    }
    if (uploadable.length === 0) return;

    setSending(true);
    try {
      const outcomes = await Promise.all(
        uploadable.map(async (asset): Promise<UploadOutcome> => {
          try {
            const response = await fetch(asset.uri);
            const blob = await response.blob();
            const uploaded = await api.uploadAttachment('conversation', conversationId, blob, {
              filename: asset.name,
            });
            return {
              ok: true,
              item: { id: uploaded.id, name: uploaded.filename, size: uploaded.sizeBytes, mime: uploaded.mime },
            };
          } catch (err) {
            return { ok: false, name: asset.name, message: err instanceof Error ? err.message : 'Upload failed' };
          }
        }),
      );

      const succeeded = outcomes.filter((o): o is UploadOutcome & { ok: true } => o.ok);
      const failed = outcomes.filter((o): o is UploadOutcome & { ok: false } => !o.ok);

      if (succeeded.length === 0) {
        Alert.alert("Couldn't attach files", failed.map((f) => `${f.name}: ${f.message}`).join('\n'));
        return;
      }

      await sendBody(encodeMedia(succeeded.map((o) => o.item)));
      // Fire-and-forget, matching the web hook: an upload that made it into a
      // sent message must not stay uncommitted and lapse after 24h, but a
      // transient commit failure is never worth blocking on or alerting for.
      void Promise.allSettled(succeeded.map((o) => api.commitAttachment(o.item.id)));

      if (failed.length > 0) {
        Alert.alert('Some files were not attached', failed.map((f) => f.name).join(', '));
      }
    } catch (err) {
      console.error('[chat-attachments] send failed', err);
      Alert.alert("Couldn't send attachment", 'Please try again.');
    } finally {
      setSending(false);
    }
  }, [api, conversationId, sendBody]);

  return { pickAndSend, sending };
}
