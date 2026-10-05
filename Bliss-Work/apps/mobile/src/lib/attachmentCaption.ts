import type { MediaItem } from '@taskboard/app/chatEnvelope';

/**
 * "You sent an image" / "sent a file" — the label shown in the bubble itself
 * under the sender's name, so an image/file message reads as a human
 * sentence rather than nothing (or, before this, nothing at all — the bubble
 * relies on the sender name row for the sending case). Wording mirrors the
 * app's other attachment labels (rowPreview.ts, listPreview in
 * chatEnvelope.ts): image/video/file, singular/plural.
 *
 * Kept as its own plain .ts module (not inline in MessageBubble.tsx) for the
 * same reason as rowPreview.ts: it's unit-tested, and a .tsx screen import
 * would drag in react-native for a Jest config that has no transform for it.
 */
export function mediaCaption(items: readonly MediaItem[], mine: boolean): string {
  const verb = (word: string) => (mine ? `You sent ${word}` : `sent ${word}`);
  if (items.length === 0) return '';
  if (items.length === 1) {
    const mime = items[0]!.mime;
    if (mime.startsWith('image/')) return verb('an image');
    if (mime.startsWith('video/')) return verb('a video');
    if (mime.startsWith('audio/')) return verb('an audio');
    return verb('a file');
  }
  const allImages = items.every((i) => i.mime.startsWith('image/'));
  return verb(allImages ? `${items.length} images` : `${items.length} files`);
}
