import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
 *   2. STAGE them — the user must still press Send
 *   3. send ONE message whose body carries those ids
 *   4. commit the attachments so they stop expiring
 *
 * Committing last is what makes an abandoned or failed send self-cleaning: the
 * server cannot read the (encrypted) message body to discover which attachments
 * are referenced, so an uncommitted upload simply lapses after 24h. Staging
 * relies on exactly that property — a file the user attaches and then thinks
 * better of costs nothing and cleans itself up.
 *
 * Step 2 is why dropping a photo into a chat no longer fires it off at the
 * recipient before the sender has had a chance to look at it. Uploading still
 * begins immediately so the progress bar is honest and Send is instant; only
 * the SEND waits for the user.
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

// NO `accept` filter on the picker, deliberately.
//
// An `accept` list does not warn or explain — it GREYS THE FILE OUT, so a user
// trying to send a .rar, .apk, .psd, .sql or anything without an extension
// simply cannot select it and has no idea why. This is a chat app: "send me
// that file" means any file.
//
// It buys nothing in return. `accept` is a client-side hint a user can bypass
// with drag-and-drop anyway, and the real safety decision is made server-side
// at DOWNLOAD time — internal/media.ServeAs forces anything script-capable to
// application/octet-stream + Content-Disposition: attachment, so a hostile
// upload downloads instead of executing. Restricting the picker only stops
// legitimate files.

export function useChatMedia(opts: ChatMediaOptions) {
  const { scope, scopeId, meId, send, p2pFallback } = opts;
  const { api, config } = useRuntime();
  const ft = useFileTransfers();

  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploads, setUploads] = useState<Record<string, UploadProgress>>({});
  const [lightbox, setLightbox] = useState<{ items: MediaItem[]; index: number } | null>(null);

  // Uploaded but NOT yet sent. The composer renders these as removable chips.
  const [staged, setStaged] = useState<MediaItem[]>([]);
  // Mirror of staged.length for onFiles' per-message cap check. A ref, so
  // onFiles keeps a stable identity instead of being rebuilt — and re-bound
  // through runFiles/dropzone/onPaste — on every attachment added or removed.
  const stagedCount = useRef(0);
  stagedCount.current = staged.length;

  // Attachments are authorized against (scope, scopeId) at upload time, so a
  // chip carried into another conversation would reference a scope the reader
  // is not in. Navigating away discards the tray; the uncommitted uploads lapse
  // on their own.
  useEffect(() => {
    setStaged([]);
    setUploads({});
  }, [scopeId]);

  // ── uploading ─────────────────────────────────────────────────────────────

  const onFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const files = Array.from(fileList);
      if (files.length === 0) return;

      // The cap is on the MESSAGE, so anything already sitting in the tray
      // counts against it — otherwise ten drops of one file each would build a
      // twelve-attachment message that the server then rejects on send.
      if (stagedCount.current + files.length > MEDIA_MAX_FILES) {
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

        // Into the tray, NOT down the wire. flushStaged (below) is the only
        // thing that sends, and it only runs when the user presses Send.
        setStaged((prev) => [...prev, ...items]);
      } catch (err) {
        pending.forEach(({ key }) => clearUpload(key));
        const message = err instanceof Error ? err.message : "Upload failed";
        toast.error(message.includes("quota") || message.includes("limit")
          ? message
          : `Couldn't send attachment: ${message}`);
      }
    },
    [api, scope, scopeId, p2pFallback, ft.available],
  );

  /**
   * Single entry point for every way a file arrives (picker, drop, paste).
   *
   * onFiles handles upload failures internally, but anything thrown BEFORE that
   * — or any bug added later — would otherwise escape as an unhandled rejection
   * and the user would see literally nothing happen. That silence is what made
   * a dropped-selection bug take three rounds to find, so the backstop is here
   * permanently: a failure must always produce a visible message and a console
   * entry, never nothing.
   */
  const runFiles = useCallback(
    (files: FileList | File[]) => {
      void onFiles(files).catch((err: unknown) => {
        console.error("[chat-media] attach failed", err);
        toast.error("Couldn't attach that file. Please try again.");
      });
    },
    [onFiles],
  );

  const onAttach = useCallback(() => fileInput.current?.click(), []);

  /** Drop one chip from the tray. The upload is left to lapse rather than
   *  deleted: it was never committed, so it expires on its own in 24h. */
  const removeStaged = useCallback((id: string) => {
    setStaged((prev) => prev.filter((it) => it.id !== id));
  }, []);

  /**
   * THE send path for every surface: emits the staged attachments (one message
   * for the whole tray, so ten photos are one bubble) and then the typed text.
   *
   * Both are optional — Send is enabled when either is present — so this is
   * also what keeps an attachment-only send from posting an empty text message
   * behind it. Commit runs after the send for the reason documented at the top
   * of this file: an upload that never made it into a message must lapse rather
   * than become unreachable garbage.
   */
  const flushStaged = useCallback(
    (text: string) => {
      const items = staged;
      if (items.length > 0) {
        setStaged([]);
        send(encodeMedia(items));
        void Promise.allSettled(items.map((it) => api.commitAttachment(it.id)));
      }
      const t = text.trim();
      if (t) send(t);
    },
    [staged, send, api],
  );

  const onPickFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      // COPY THE FILES OUT FIRST. `e.target.files` is a LIVE FileList — in
      // Chromium it is the same object every time, and setting `value = ""`
      // empties it IN PLACE. Reading `files.length` after the reset therefore
      // saw 0 and silently dropped every selection: no upload, no error, no
      // toast, nothing at all. It survived a jsdom test because jsdom replaces
      // the FileList rather than mutating it, so the captured reference stayed
      // populated there while every real browser dropped it.
      const files = Array.from(e.target.files ?? []);
      // Reset only AFTER copying, so re-picking the same file still fires change.
      e.target.value = "";
      if (files.length) runFiles(files);
    },
    [runFiles],
  );

  // ── location ──────────────────────────────────────────────────────────────

  /**
   * Send a pin, TAGGED with a place name where one can be resolved.
   *
   * The label is what makes the bubble read "12 Rue Foo, Paris" instead of
   * "Shared location", and it is also the `q=` term on the Apple Maps deep
   * link — so on macOS an untagged pin loses its name twice over. Resolution is
   * best-effort: reverseGeocode answers null on any failure and the coordinates
   * card is fully functional without it, so a slow or unconfigured provider
   * must never block the send.
   */
  const sendLocation = useCallback(
    async (pos: { lat: number; lng: number; accuracy?: number }) => {
      const label = (await api.reverseGeocode(pos.lat, pos.lng)) ?? undefined;
      send(
        encodeLocation({
          lat: pos.lat,
          lng: pos.lng,
          accuracy: pos.accuracy,
          label,
        }),
      );
    },
    [api, send],
  );

  const onShareLocation = useCallback(() => {
    const pending = toast.loading("Getting your location…");

    /**
     * Last resort: ask the server where this IP is.
     *
     * Chromium's network locator needs a Google API key Electron does not ship,
     * and a Linux desktop has no OS locator to fall back on — so
     * getCurrentPosition fails outright there however the permission is set.
     * A city-level fix is far better than refusing, provided the user is TOLD
     * it is approximate; the large accuracy makes the bubble say so too.
     */
    const fallback = async (reason: string) => {
      // Ask the host WHY precision was unavailable before blaming the device.
      // A desktop build with no geolocation API key cannot get a precise fix on
      // any machine, and telling that user to check their location services
      // sends them to fix something that was never broken. Absent on web (and
      // on older desktop builds), where the browser owns the provider.
      const precise = (await config.hasPreciseLocation?.()) ?? true;
      const coarse = await api.whereami();
      toast.dismiss(pending);
      if (!coarse) {
        toast.error(reason);
        return;
      }
      await sendLocation(coarse);
      toast("Shared an approximate location", {
        description: precise
          ? "Your device couldn't get a precise fix, so this is based on your network."
          : "This build has no precise location provider, so this is based on your network.",
      });
    };

    if (typeof navigator === "undefined" || !navigator.geolocation) {
      void fallback("Location sharing isn't available on this device.");
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        toast.dismiss(pending);
        void sendLocation({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : undefined,
        });
      },
      (err) => {
        // "You said no" is the one case with no fallback: overriding an
        // explicit refusal with an IP lookup would be a betrayal, not a
        // feature. Everything else is the device failing, not the user
        // declining, so it is worth trying the coarse path.
        if (err.code === err.PERMISSION_DENIED) {
          toast.dismiss(pending);
          toast.error(
            "Location permission denied. Enable it in your system settings to share your location.",
          );
          return;
        }
        void fallback(
          "Couldn't determine your location. Try again, or check that location services are on.",
        );
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    );
  }, [api, config, sendLocation]);

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
        if (e.dataTransfer.files?.length) runFiles(e.dataTransfer.files);
      },
    }),
    [runFiles],
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
      runFiles(files);
    },
    [runFiles],
  );

  const fileInputProps = {
    ref: fileInput,
    type: "file" as const,
    multiple: true,
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
    /** Uploaded, awaiting an explicit Send. Render as removable chips. */
    staged,
    removeStaged,
    /** Call from the composer's Send. Sends the tray, then the text. */
    flushStaged,
    fileInputProps,
    overlay,
  };
}
