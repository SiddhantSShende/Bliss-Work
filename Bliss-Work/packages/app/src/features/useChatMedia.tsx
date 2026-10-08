import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
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
import { isUrlOnly } from "../lib/chatFormat";
import { makeThumbnail } from "../lib/thumbnail";
import { useAttachmentLinks } from "../lib/useAttachmentLinks";
import { useAttachmentActivity } from "../lib/useAttachmentActivity";
import { downloadAttachment } from "../lib/download";
import { hasOutsideOpen, openOutsideApp } from "../lib/openAttachment";
import { attachmentCapability } from "../lib/attachmentCapability";
import { useFileTransfers } from "../lib/fileTransfer";
import { MediaBubble, type UploadProgress } from "./MediaBubble";
import { LocationBubble } from "./LocationBubble";
import { AttachmentViewer } from "./AttachmentViewer";
import { FileAttachmentBubble } from "./FileAttachmentBubble";
import { DropConfirm } from "./DropConfirm";

/**
 * All of media + location sharing for one chat surface, in one hook.
 *
 * DMs, channels and Inbox threads each have their own container component
 * (`DMView`, `ChannelView`, `MailThread`) with its own send mutation, and the
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
 *
 * A DROP goes one step further and asks first (DropConfirm), so step 1 does not
 * even start. The picker and paste are deliberate acts — you opened a file
 * dialog, you pressed a key combination — but a drop can happen entirely by
 * accident, releasing a dragged file a few pixels short of the folder you meant.
 * Confirming before uploading means an accidental drop costs nothing at all:
 * the bytes never leave the machine and there is no orphaned upload to lapse.
 */

interface ChatMediaOptions {
  scope: AttachmentScope;
  scopeId: string;
  meId: string;
  /** Channel surface only: the channel's `isLocked`. Whether file activity is also
   *  shown in the chat — see showsAttachmentActivity. */
  channelLocked?: boolean;
  /** The surface's own send path — reply, replyToThread, sendChannelMessage. */
  send: (body: string) => void;
  /**
   * Peer-to-peer fallback for files over the server limit. Only 1:1 surfaces
   * pass this; WebRTC has no channel fanout.
   */
  p2pFallback?: (file: File) => void;
}

/** Result of uploading one file in a batch — see onFiles below. Per-file, so a
 *  failure names the file it belongs to instead of failing the whole batch. */
type UploadOutcome =
  | { ok: true; item: MediaItem }
  | { ok: false; name: string; message: string };

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
  const { scope, scopeId, meId, channelLocked, send, p2pFallback } = opts;
  const { t } = useTranslation("chatMedia");
  const { api, config } = useRuntime();
  const ft = useFileTransfers();

  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploads, setUploads] = useState<Record<string, UploadProgress>>({});
  const [lightbox, setLightbox] = useState<{ items: MediaItem[]; index: number } | null>(null);
  // Dropped, awaiting the user's "yes". Not uploaded, not staged — see the note
  // at the top of this file and DropConfirm.
  const [dropped, setDropped] = useState<File[] | null>(null);

  // Uploaded but NOT yet sent. The composer renders these as removable chips.
  const [staged, setStaged] = useState<MediaItem[]>([]);
  // Mirror of staged.length for onFiles' per-message cap check. A ref, so
  // onFiles keeps a stable identity instead of being rebuilt — and re-bound
  // through runFiles/dropzone/onPaste — on every attachment added or removed.
  const stagedCount = useRef(0);
  stagedCount.current = staged.length;

  // The scope onFiles is CURRENTLY running for. An upload started in one
  // conversation can finish after the user has switched to another — the
  // scope-reset effect below already cleared that new conversation's tray by
  // then, so appending the late result would land it in a scope it was never
  // authorized against. onFiles compares this against the scope it captured
  // at call time before staging (see below).
  const currentScope = useRef({ scope, scopeId });
  currentScope.current = { scope, scopeId };

  // Attachments are authorized against (scope, scopeId) at upload time, so a
  // chip carried into another conversation would reference a scope the reader
  // is not in. Navigating away discards the tray; the uncommitted uploads lapse
  // on their own.
  useEffect(() => {
    setStaged([]);
    setUploads({});
    setLightbox(null);
    // A pending drop belongs to the conversation it was dropped on. Leaving it
    // open across a navigation would attach those files to whatever chat the
    // user landed in.
    setDropped(null);
    // Every attachment id this scope ever rendered otherwise accumulates in
    // seenIds forever (it's the one piece of this hook's state the reset
    // above didn't already cover) — unbounded growth over a long session, and
    // useAttachmentLinks kept re-requesting signed links for ids belonging to
    // conversations no longer on screen. idsVersion has to bump too: allIds
    // is memoized on it, not on seenIds itself (a stable ref), so clearing
    // the set alone wouldn't make allIds/links notice.
    seenIds.current.clear();
    setIdsVersion((v) => v + 1);
  }, [scope, scopeId]);

  // ── uploading ─────────────────────────────────────────────────────────────

  const onFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const files = Array.from(fileList);
      if (files.length === 0) return;

      // The cap is on the MESSAGE, so anything already sitting in the tray
      // counts against it — otherwise ten drops of one file each would build a
      // twelve-attachment message that the server then rejects on send.
      if (stagedCount.current + files.length > MEDIA_MAX_FILES) {
        toast.error(t("attachments.tooManyFiles", { max: MEDIA_MAX_FILES }));
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
            t("attachments.overSizePeerToPeer", {
              name: file.name,
              size: prettySize(MEDIA_MAX_BYTES),
            }),
          );
          p2pFallback(file);
        } else {
          toast.error(t("attachments.tooLarge", { name: file.name, size: prettySize(MEDIA_MAX_BYTES) }));
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

      // Each file uploads independently: one failing must not discard the
      // others. Every branch below resolves rather than rejects — the failure
      // is caught right where the file name is still in scope — which is what
      // makes this safe to await with Promise.all instead of needing to zip a
      // Promise.allSettled result back up against `pending` by index. A batch
      // of ten photos where nine succeeded and one hit a transient error now
      // still stages those nine; before, any single rejection failed the
      // whole Promise.all, discarding uploads that had already landed
      // server-side (left to silently lapse after 24h, per the header doc)
      // while telling the user nothing had sent.
      const outcomes = await Promise.all(
        pending.map(async ({ file, key }): Promise<UploadOutcome> => {
          try {
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
            return { ok: true, item };
          } catch (err) {
            clearUpload(key);
            return {
              ok: false,
              name: file.name,
              message: err instanceof Error ? err.message : t("attachments.uploadFailed"),
            };
          }
        }),
      );

      const succeeded = outcomes.filter((o): o is UploadOutcome & { ok: true } => o.ok);
      const failures = outcomes.filter((o): o is UploadOutcome & { ok: false } => !o.ok);

      // If the user has since switched to a different conversation, the
      // scope-reset effect already cleared ITS tray — appending here would
      // land these items in a scope they were never authorized against.
      // Drop them instead: they were never staged or sent, so (per this
      // file's header doc) the uncommitted upload simply lapses in 24h,
      // same as any other attach the user never sent.
      const stillInScope =
        currentScope.current.scope === scope && currentScope.current.scopeId === scopeId;

      // Into the tray, NOT down the wire. flushStaged (below) is the only
      // thing that sends, and it only runs when the user presses Send.
      if (stillInScope && succeeded.length > 0) {
        setStaged((prev) => [...prev, ...succeeded.map((o) => o.item)]);
      }

      // Failures are never silent, even when some files in the same batch
      // succeeded — the user needs to know which one(s) didn't make it.
      if (failures.length > 0) {
        const names = failures.map((f) => f.name).join(", ");
        toast.error(
          failures.length === 1
            ? t("attachments.attachFailedSingle", {
                name: names,
                message: failures[0]?.message ?? t("attachments.uploadFailed"),
              })
            : t("attachments.attachFailedMultiple", { count: failures.length, names }),
        );
      }
    },
    [api, scope, scopeId, p2pFallback, ft.available, t],
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
        toast.error(t("attachments.attachFailedGeneric"));
      });
    },
    [onFiles, t],
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
    const pending = toast.loading(t("shareLocation.gettingLocation"));

    /**
     * Last resort: ask the server where this IP is.
     *
     * Chromium's network locator needs a Google API key Electron does not ship,
     * and a Linux desktop has no OS locator to fall back on — so
     * getCurrentPosition fails outright there however the permission is set.
     * A city-level fix is far better than refusing, provided the user is TOLD
     * it is approximate; the large accuracy makes the bubble say so too.
     */
    const fallback = async (reason: string, deniedByPlatform = false) => {
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

      // Offer the OS settings page only when the OS is what refused AND this
      // platform actually has such a page (Windows and macOS; Linux has no
      // location provider to authorize, so the host omits the capability).
      //
      // Both halves matter. A keyless build that simply could not get a fix
      // would otherwise send the user off to toggle a setting that was never
      // the cause — the same "go fix something that isn't broken" the `precise`
      // check below already exists to avoid.
      const openSettings = deniedByPlatform ? config.openLocationSettings : undefined;
      toast(t("shareLocation.approximateShared"), {
        description: openSettings
          ? t("shareLocation.reasons.desktopAccessOff")
          : precise
            ? t("shareLocation.reasons.noPreciseFix")
            : t("shareLocation.reasons.noProvider"),
        ...(openSettings && {
          action: { label: t("shareLocation.openSettings"), onClick: () => void openSettings() },
        }),
      });
    };

    // Whether a PERMISSION_DENIED from this host can mean "the user declined".
    // Only a browser prompts; the desktop shell answers the permission request
    // itself. See the error handler below.
    const hostAsksTheUser = config.kind === "web";

    if (typeof navigator === "undefined" || !navigator.geolocation) {
      void fallback(t("shareLocation.notAvailable"));
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
        //
        // But a refusal is only something the USER can have made where the user
        // was actually ASKED, and in the desktop app they never are: the main
        // process grants "geolocation" unconditionally in its
        // setPermissionRequestHandler (apps/desktop/src/main/index.ts), so
        // Chromium shows no prompt and there is no dialog to decline. A
        // PERMISSION_DENIED there is the PLATFORM refusing, not the person —
        // Windows with "let desktop apps access your location" off (which never
        // prompts a Win32 app at all, so the user CANNOT be asked), macOS with
        // Location Services off, or Linux, which has no OS locator to refuse
        // with in the first place.
        //
        // Reading that as an explicit refusal is what made "share location"
        // fail outright on desktop — the error told people to change a setting
        // they had never been offered, while the coarse path that would have
        // answered sat unused two lines below.
        if (err.code === err.PERMISSION_DENIED && hostAsksTheUser) {
          toast.dismiss(pending);
          toast.error(t("shareLocation.permissionDenied"));
          return;
        }
        void fallback(
          t("shareLocation.determineFailed"),
          err.code === err.PERMISSION_DENIED,
        );
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    );
  }, [api, config, sendLocation, t]);

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
  const reportAttachmentActivity = useAttachmentActivity(scope, scopeId, meId, channelLocked);

  // A click on an attachment, routed by `attachmentCapability` (the one place that
  // decides, shared with Mail and the assets panel):
  //
  //   native    → the Lightbox, with the message's drawable files as a gallery.
  //   external  → audio: out of the app the way an email attachment's Open does
  //               (the desktop's own application, a browser tab on web); a host
  //               with neither falls through to the Lightbox. Exactly the old path.
  //   document  → Word / PowerPoint / Excel / CSV / .txt, in the in-app document
  //               viewer, shown ALONE so ←/→ can never land on a file the
  //               Lightbox cannot draw.
  //   download  → nothing opens. FileCard offers only Download for these, so a
  //               click never gets here; the guard is for any other caller.
  //
  // Every opening branch is the user invoking the app's OPEN action — never a
  // render, a viewport entry or a hover — so it reports exactly one
  // "attachment_opened", and never "attachment_downloaded": that kind belongs to
  // the explicit Download (downloadItem below) alone.
  const openItem = useCallback(
    (items: MediaItem[], index: number) => {
      const item = items[index];
      if (!item) return;
      const cap = attachmentCapability({ name: item.name, mime: item.mime, size: item.size });
      if (cap.kind === "download") return;
      const url = links.urlFor(item.id);
      if (cap.kind === "external" && url && openOutsideApp(config, item.mime, url, item.name)) {
        reportAttachmentActivity("attachment_opened", item);
        return;
      }
      reportAttachmentActivity("attachment_opened", item);
      if (cap.kind === "document") {
        setLightbox({ items: [item], index: 0 });
        return;
      }
      // The Lightbox's gallery holds only what it can draw (or, for audio on a host
      // with no outside open, explain): ←/→ must never carry the user onto a
      // document — which would swap the viewer and start a conversion — or onto a
      // download-only file, which has nothing to show.
      const gallery = items.filter((i) => {
        const k = attachmentCapability({ name: i.name, mime: i.mime, size: i.size }).kind;
        return k === "native" || k === "external";
      });
      setLightbox({ items: gallery, index: gallery.indexOf(item) });
    },
    [config, links, reportAttachmentActivity],
  );

  // A file's 3-dot menu → Download: the ONLY deliberate download. Saves through
  // the viewer's own signed URL with the server's explicit-download flag (see
  // downloadAttachment) and records exactly one "attachment_downloaded" — never
  // an "opened" too, since nothing here goes through openItem. No resolved URL
  // (still loading, or the server would not mint one for this viewer) means
  // nothing was downloaded, so nothing is reported.
  const downloadItem = useCallback(
    (item: Pick<MediaItem, "id" | "name">) => {
      const url = links.urlFor(item.id);
      if (!url) return;
      downloadAttachment(url, item.name);
      reportAttachmentActivity("attachment_downloaded", item);
    },
    [links, reportAttachmentActivity],
  );

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
            opensOutside={hasOutsideOpen(config)}
            onOpen={(index) => openItem(env.items, index)}
            onDownload={downloadItem}
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
          onDecline={!mine ? () => ft.decline(offer, m.senderId) : undefined}
          onCancel={() => ft.cancel(offer.offerId)}
        />
      );
    },
    [meId, links, noteIds, ft, config, openItem, downloadItem],
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
        // Dragging a LINK (a browser's address bar, a hyperlink on a page)
        // can still advertise a "Files" type — the OS/Chromium hands drop
        // targets a synthetic file (e.g. an Internet Shortcut) for the same
        // drag, particularly on Electron's bundled Chromium. `getData` is
        // only readable at drop time (not dragover), so this is the first
        // point a bare-URL drag can be told apart from an actual file drop —
        // see isUrlOnly's own doc for why.
        if (isUrlOnly(e.dataTransfer.getData("text/plain").trim())) return;
        // COPY THE FILES OUT NOW. `e.dataTransfer.files` is only valid during
        // the event; holding the FileList to read after the confirmation
        // dialog would find it empty.
        const files = Array.from(e.dataTransfer.files ?? []);
        if (files.length) setDropped(files);
      },
    }),
    [],
  );

  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.items ?? [])
        .filter((i) => i.kind === "file")
        .map((i) => i.getAsFile())
        .filter((f): f is File => f !== null);
      if (files.length === 0) return;
      // Copying a LINK (a browser's address bar, an app's "Copy Link") can
      // still populate a file-kind clipboard item alongside the plain-text
      // URL — the OS clipboard hands paste targets a synthetic file (e.g. an
      // Internet Shortcut) for the same copy, particularly on Electron's
      // bundled Chromium, which is why a link only mis-sent as an attachment
      // on desktop. A file-kind item alone is not proof of an actual file:
      // when the pasted text is nothing but a URL, let it through as an
      // ordinary link message instead — see isUrlOnly's own doc.
      if (isUrlOnly((e.clipboardData?.getData("text/plain") ?? "").trim())) return;
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

  const overlay = (
    <>
      {lightbox && (
        <AttachmentViewer
          items={lightbox.items}
          index={lightbox.index}
          urlFor={links.urlFor}
          onClose={() => setLightbox(null)}
          onIndexChange={(index) => setLightbox((l) => (l ? { ...l, index } : l))}
          onDownload={downloadItem}
        />
      )}
      <DropConfirm
        files={dropped}
        onConfirm={() => {
          const files = dropped;
          setDropped(null);
          if (files?.length) runFiles(files);
        }}
        onCancel={() => setDropped(null)}
      />
    </>
  );

  return {
    renderBody,
    /** Explicit 3-dot → Download of one file; see the callback's comment. */
    downloadItem,
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
