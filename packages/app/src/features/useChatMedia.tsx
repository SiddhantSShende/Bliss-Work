import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { AttachmentScope } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import {
  MEDIA_MAX_BYTES,
  MEDIA_MAX_FILES,
  attachmentIdsOf,
  encodeLocation,
  encodeMedia,
  parseChatEnvelope,
  prettySize,
  type MediaItem,
} from "../lib/chatEnvelope";
import { makeThumbnail } from "../lib/thumbnail";
import { useAttachmentLinks } from "../lib/useAttachmentLinks";
import { useFileTransfers } from "../lib/fileTransfer";
import { MediaBubble, type UploadProgress } from "./MediaBubble";
import { LocationBubble } from "./LocationBubble";
import { Lightbox } from "./Lightbox";
import { FileAttachmentBubble } from "./FileAttachmentBubble";

/**
 * All of media + location sharing for one chat surface, in one hook.
 *
 * DMs, channels and Inbox threads each have their own container component
 * (`DMView`, `ChannelView`, `InboxThread`) with its own send mutation, and the
 * message list itself is forked between `ChatThread` and `ThreadView`. Rather
 * than implement attachments three times, everything lives here and each
 * surface supplies two things: which scope it is, and how to send a message.
 *
 * The upload/send order matters and is not arbitrary:
 *   1. upload the bytes and get back attachment ids
 *   2. send ONE message whose body carries those ids
 *   3. commit the attachments so they stop expiring
 *
 * Committing last is what makes an abandoned or failed send self-cleaning: the
 * server cannot read the (encrypted) message body to discover which attachments
 * are referenced, so an uncommitted upload simply lapses after 24h.
 */

export interface ChatMediaOptions {
  scope: AttachmentScope;
  scopeId: string;
  meId: string;
  /** The surface's own send path — reply, replyToThread, sendChannelMessage. */
  send: (body: string) => void;
  /**
   * Peer-to-peer fallback for files over the server limit. Only 1:1 surfaces
   * pass this; WebRTC has no channel fanout.
   */
  p2pFallback?: (file: File) => void;
}

/** Accepted by the picker. Broad on purpose — the server decides what's safe. */
const ACCEPT = "image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip";

export function useChatMedia(opts: ChatMediaOptions) {
  const { scope, scopeId, meId, send, p2pFallback } = opts;
  const { api } = useRuntime();
  const ft = useFileTransfers();

  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploads, setUploads] = useState<Record<string, UploadProgress>>({});
  const [lightbox, setLightbox] = useState<{ items: MediaItem[]; index: number } | null>(null);

  // ── uploading ─────────────────────────────────────────────────────────────

  const onFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const files = Array.from(fileList);
      if (files.length === 0) return;

      if (files.length > MEDIA_MAX_FILES) {
        toast.error(`You can send up to ${MEDIA_MAX_FILES} files at a time.`);
        return;
      }

      // Oversized files never reach the upload path — they go peer-to-peer
      // (where the limit is the transfer, not our disk) or are refused.
      const uploadable: File[] = [];
      for (const file of files) {
        if (file.size <= MEDIA_MAX_BYTES) {
          uploadable.push(file);
          continue;
        }
        if (p2pFallback && ft.available) {
          toast.info(
            `${file.name} is over ${prettySize(MEDIA_MAX_BYTES)} — sending peer-to-peer. ` +
              `You both need to stay online until it finishes.`,
          );
          p2pFallback(file);
        } else {
          toast.error(`${file.name} is larger than ${prettySize(MEDIA_MAX_BYTES)}.`);
        }
      }
      if (uploadable.length === 0) return;

      // Local keys let the progress overlay track a file before it has a
      // server-assigned id.
      const pending = uploadable.map((file) => ({ file, key: crypto.randomUUID() as string }));
      setUploads((prev) => {
        const next = { ...prev };
        pending.forEach(({ key }) => (next[key] = { ratio: 0 }));
        return next;
      });

      const clearUpload = (key: string) =>
        setUploads((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });

      try {
        const items = await Promise.all(
          pending.map(async ({ file, key }) => {
            // Best-effort poster; never allowed to block or fail the send.
            const { thumb, dimensions } = await makeThumbnail(file);

            const uploaded = await api.uploadAttachment(
              scope,
              scopeId,
              file,
              {
                filename: file.name,
                width: dimensions.width,
                height: dimensions.height,
                durationMs: dimensions.durationMs,
                onProgress: (loaded, total) =>
                  setUploads((prev) => ({ ...prev, [key]: { ratio: total ? loaded / total : 0 } })),
              },
            );

            let thumbId: string | undefined;
            if (thumb) {
              try {
                const t = await api.uploadAttachment(scope, scopeId, thumb.blob, {
                  filename: `thumb-${uploaded.id}.webp`,
                  role: "thumb",
                  parentId: uploaded.id,
                  width: thumb.width,
                  height: thumb.height,
                });
                thumbId = t.id;
              } catch {
                // A missing poster is cosmetic — MediaBubble falls back to the
                // full image or a poster-less video. Never fail the send for it.
              }
            }

            clearUpload(key);
            const item: MediaItem = {
              id: uploaded.id,
              name: uploaded.filename,
              size: uploaded.sizeBytes,
              // The SERVER's sniffed type, not file.type — the client's is an
              // unverified guess and must not drive rendering.
              mime: uploaded.mime,
              thumbId,
              width: dimensions.width,
              height: dimensions.height,
              durationMs: dimensions.durationMs,
            };
            return item;
          }),
        );

        // One message for the whole batch, so ten photos are one bubble.
        send(encodeMedia(items));

        // Commit only after the message is on its way. If the send throws, the
        // uploads lapse on their own rather than becoming unreachable garbage.
        await Promise.allSettled(items.map((it) => api.commitAttachment(it.id)));
      } catch (err) {
        pending.forEach(({ key }) => clearUpload(key));
        const message = err instanceof Error ? err.message : "Upload failed";
        toast.error(message.includes("quota") || message.includes("limit")
          ? message
          : `Couldn't send attachment: ${message}`);
      }
    },
    [api, scope, scopeId, send, p2pFallback, ft.available],
  );

  const onAttach = useCallback(() => fileInput.current?.click(), []);

  const onPickFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      // Reset first so re-picking the same file fires change again.
      e.target.value = "";
      if (files?.length) void onFiles(files);
    },
    [onFiles],
  );

  // ── location ──────────────────────────────────────────────────────────────

  const onShareLocation = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      toast.error("Location sharing isn't available on this device.");
      return;
    }
    const pending = toast.loading("Getting your location…");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        toast.dismiss(pending);
        send(
          encodeLocation({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : undefined,
          }),
        );
      },
      (err) => {
        toast.dismiss(pending);
        // Distinguish "you said no" from "your device couldn't" — the fixes are
        // completely different and a generic message helps nobody.
        toast.error(
          err.code === err.PERMISSION_DENIED
            ? "Location permission denied. Enable it in your browser settings to share your location."
            : "Couldn't determine your location. Try again, or check that location services are on.",
        );
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    );
  }, [send]);

  // ── rendering ─────────────────────────────────────────────────────────────

  // `renderBody` is called per message, but links must be minted in one batch
  // for the whole page — so the ids are collected from the rendered messages and
  // resolved by a single query.
  const seenIds = useRef<Set<string>>(new Set());
  const [idsVersion, setIdsVersion] = useState(0);
  const noteIds = useCallback((ids: string[]) => {
    let added = false;
    for (const id of ids) {
      if (!seenIds.current.has(id)) {
        seenIds.current.add(id);
        added = true;
      }
    }
    // Defer the state update out of render.
    if (added) queueMicrotask(() => setIdsVersion((v) => v + 1));
  }, []);

  const allIds = useMemo(
    () => Array.from(seenIds.current),
    // idsVersion is the intentional trigger; seenIds is a stable ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [idsVersion],
  );
  const links = useAttachmentLinks(allIds);

  const renderBody = useCallback(
    (m: { id: string; senderId: string; body: string }) => {
      const env = parseChatEnvelope(m.body);
      if (!env) return null;
      const mine = m.senderId === meId;

      if (env.kind === "location") return <LocationBubble env={env} mine={mine} />;

      if (env.kind === "media") {
        noteIds(attachmentIdsOf(env));
        return (
          <MediaBubble
            items={env.items}
            mine={mine}
            urlFor={links.urlFor}
            isResolved={links.isResolved}
            onOpen={(index) => setLightbox({ items: env.items, index })}
          />
        );
      }

      // v1 peer-to-peer file offer — unchanged behaviour for historical
      // messages and for files over the server limit.
      const offer = env.offer;
      const state = ft.stateOf(offer.offerId) ?? { kind: "OFFERED" as const };
      return (
        <FileAttachmentBubble
          mine={mine}
          fileName={offer.name}
          fileSize={offer.size}
          state={state}
          onAccept={!mine ? () => ft.accept(offer) : undefined}
          onDecline={!mine ? () => ft.decline(offer, m.senderId) : undefined}
          onCancel={() => ft.cancel(offer.offerId)}
        />
      );
    },
    [meId, links, noteIds, ft],
  );

  // ── drag & drop / paste ───────────────────────────────────────────────────

  const dropzone = useMemo(
    () => ({
      onDragOver: (e: React.DragEvent) => {
        // Only react to an actual file drag, not text selections being dragged
        // around inside the composer.
        if (!Array.from(e.dataTransfer.types).includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      },
      onDragLeave: (e: React.DragEvent) => {
        // Ignore the leave events fired while moving between child elements.
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setDragging(false);
      },
      onDrop: (e: React.DragEvent) => {
        if (!Array.from(e.dataTransfer.types).includes("Files")) return;
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files?.length) void onFiles(e.dataTransfer.files);
      },
    }),
    [onFiles],
  );

  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.items ?? [])
        .filter((i) => i.kind === "file")
        .map((i) => i.getAsFile())
        .filter((f): f is File => f !== null);
      if (files.length === 0) return;
      // Let a normal text paste through untouched.
      e.preventDefault();
      void onFiles(files);
    },
    [onFiles],
  );

  const fileInputProps = {
    ref: fileInput,
    type: "file" as const,
    multiple: true,
    accept: ACCEPT,
    hidden: true,
    onChange: onPickFile,
  };

  const overlay = lightbox ? (
    <Lightbox
      items={lightbox.items}
      index={lightbox.index}
      urlFor={links.urlFor}
      onClose={() => setLightbox(null)}
      onIndexChange={(index) => setLightbox((l) => (l ? { ...l, index } : l))}
    />
  ) : null;

  return {
    renderBody,
    onAttach,
    onShareLocation,
    onFiles,
    onPaste,
    dropzone,
    dragging,
    uploads,
    fileInputProps,
    overlay,
  };
}
