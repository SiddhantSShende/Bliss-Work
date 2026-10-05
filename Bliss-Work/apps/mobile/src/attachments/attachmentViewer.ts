import { useSyncExternalStore } from 'react';

/**
 * What's on screen in the shared attachment viewer (AttachmentViewerHost,
 * mounted once in App.tsx) — the single place every attachment tap in the
 * app (chat/channel bubbles, the Media/Links/Docs modal, the channel Files
 * screen) opens things through, so there is exactly one viewer, never a
 * second ad-hoc one per screen.
 *
 *  - 'image': the full-screen pinch-zoom lightbox. `images` is every visual
 *    in the SAME message (so swiping moves between them, like a real photo
 *    viewer), `index` is which one was tapped.
 *  - 'doc': an in-app preview for a type the OS's own WebView can render
 *    directly from our signed URL (PDF, plain text) — see
 *    chatEnvelope.ts's `canPreviewDocInApp`.
 *  - 'details': the fallback for anything else — a small BlissWork sheet
 *    naming the file, its size and type, with an explicit "Open externally"
 *    action. Never a silent, automatic browser open.
 */
export type AttachmentViewerState =
  | { kind: 'image'; images: { uri: string; name: string }[]; index: number }
  | { kind: 'doc'; url: string; name: string; mime: string }
  | { kind: 'details'; name: string; sizeBytes: number; mime: string; url: string | undefined }
  | null;

let state: AttachmentViewerState = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export const attachmentViewer = {
  get: (): AttachmentViewerState => state,
  subscribe: (l: () => void): (() => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  open: (next: NonNullable<AttachmentViewerState>) => {
    state = next;
    emit();
  },
  close: () => {
    if (!state) return;
    state = null;
    emit();
  },
};

export function useAttachmentViewer(): AttachmentViewerState {
  return useSyncExternalStore(attachmentViewer.subscribe, attachmentViewer.get);
}
