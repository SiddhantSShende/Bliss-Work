/**
 * Everything shared in a conversation, in one panel.
 *
 * Built from the messages the thread has already loaded (lib/chatAssets) rather
 * than from an endpoint, because there is no endpoint that could answer it:
 * message bodies are encrypted at rest, so the attachment envelope and any link
 * inside the text are only ever readable on the client. The panel says what it
 * covers instead of implying it holds the whole history.
 *
 * Sheet + Tabs + a count line: the same shape every "show me the contents of
 * this thing" panel in the app uses.
 */
import { useMemo, useState } from "react";
import { ExternalLink, FileText, Images, Link2, Play } from "lucide-react";
import { EmptyState } from "@taskboard/ui";
import {
  collectChatAssets,
  type AssetMessage,
  type LinkAsset,
  type MediaAsset,
} from "../lib/chatAssets";
import { canPreviewDocInApp, prettySize } from "../lib/chatEnvelope";
import { relativeTime } from "../lib/relativeTime";
import { useAttachmentLinks } from "../lib/useAttachmentLinks";
import { Lightbox } from "./Lightbox";
import { Sheet } from "./Modal";
import { Tabs, type TabSpec } from "./Tabs";

type AssetTab = "media" | "docs" | "links";

export function ChatAssetsSheet({
  open,
  onClose,
  title,
  messages,
}: {
  open: boolean;
  onClose: () => void;
  /** What titles the conversation on screen — "#general", or the peer's name. */
  title: string;
  /** The thread as it is currently loaded, in send order. */
  messages: readonly AssetMessage[];
}) {
  const [tab, setTab] = useState<AssetTab>("media");
  // A single doc opened from the Docs tab, previewed in the SAME Lightbox the
  // inline chat bubble and the Media tab use — one in-app viewer, not a
  // second bespoke one for this panel.
  const [docPreview, setDocPreview] = useState<MediaAsset | null>(null);
  const assets = useMemo(() => collectChatAssets(messages), [messages]);

  // One batched mint for every file on this panel — the same request the thread
  // makes for its bubbles, so opening this costs one round trip, not one per
  // tile. Thumbnails are included: a video tile shows its poster, not its bytes.
  const ids = useMemo(
    () =>
      [...assets.media, ...assets.docs].flatMap((a) =>
        [a.item.id, a.item.thumbId].filter((id): id is string => !!id),
      ),
    [assets],
  );
  const { urlFor, isResolved } = useAttachmentLinks(ids);

  const tabs: readonly TabSpec<AssetTab>[] = [
    { key: "media", label: "Media", badge: assets.media.length },
    { key: "docs", label: "Docs", badge: assets.docs.length },
    { key: "links", label: "Links", badge: assets.links.length },
  ];

  return (
    <>
      <Sheet open={open} onClose={onClose} title={title} showClose>
        <Tabs tabs={tabs} active={tab} onChange={setTab} className="mb-3" />

        {/* The bound, said once. Everything on this panel comes out of the
            messages on screen, and scrolling the thread up widens it. */}
        <p className="mb-3 text-xs text-muted">
          From the {messages.length} message{messages.length === 1 ? "" : "s"} loaded here — load
          older messages in the conversation to include more.
        </p>

        {tab === "media" && <MediaGrid assets={assets.media} urlFor={urlFor} isResolved={isResolved} />}
        {tab === "docs" && <DocList assets={assets.docs} urlFor={urlFor} onPreview={setDocPreview} />}
        {tab === "links" && <LinkList assets={assets.links} />}
      </Sheet>

      {/* Rendered as a SIBLING of Sheet, not nested inside it: the sheet's
          panel is animated with a framer-motion `transform` (even at rest,
          `x: 0` still sets one), which becomes a new containing block for any
          `position: fixed` descendant — nesting Lightbox in there would trap
          its "full-screen" backdrop inside the narrow sheet panel instead of
          covering the viewport. */}
      {docPreview && (
        <Lightbox
          items={[docPreview.item]}
          index={0}
          urlFor={urlFor}
          onClose={() => setDocPreview(null)}
          onIndexChange={() => {}}
        />
      )}
    </>
  );
}

/** Provenance, on one muted line: who shared it and when. */
function Shared({ senderName, at }: { senderName?: string; at?: string }) {
  return (
    <span className="truncate text-xs text-muted">
      {[senderName, at ? relativeTime(at) : null].filter(Boolean).join(" · ")}
    </span>
  );
}

function MediaGrid({
  assets,
  urlFor,
  isResolved,
}: {
  assets: MediaAsset[];
  urlFor: (id: string | undefined) => string | undefined;
  isResolved: boolean;
}) {
  if (assets.length === 0) {
    return (
      <EmptyState
        icon={<Images size={22} />}
        title="No photos or video yet"
        hint="Images and clips shared in this conversation collect here."
      />
    );
  }
  return (
    <div className="grid grid-cols-3 gap-1.5">
      {assets.map(({ item, messageId, senderName, at }) => {
        // Poster first, full file second: a video has no inline preview of its
        // own and a large photo should not be downloaded to draw a 96px tile.
        const preview = urlFor(item.thumbId) ?? urlFor(item.id);
        const full = urlFor(item.id);
        const isVideo = item.mime.startsWith("video/");
        return (
          <a
            key={`${messageId}:${item.id}`}
            href={full ?? undefined}
            target="_blank"
            rel="noopener noreferrer"
            title={`${item.name}${senderName ? ` · ${senderName}` : ""}${at ? ` · ${relativeTime(at)}` : ""}`}
            aria-label={`Open ${item.name}`}
            className="group relative aspect-square overflow-hidden rounded-xl bg-surface-2 ring-1 ring-border/60 transition hover:ring-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {preview ? (
              <img
                src={preview}
                alt={item.name}
                loading="lazy"
                className="h-full w-full object-cover transition group-hover:scale-[1.03]"
              />
            ) : (
              // Resolved with no URL means the file is not readable by this
              // viewer any more — a different statement from "still loading".
              <span className="flex h-full w-full items-center justify-center text-[10px] text-muted">
                {isResolved ? "Unavailable" : ""}
              </span>
            )}
            {isVideo && (
              <span className="absolute inset-0 flex items-center justify-center">
                <span className="rounded-full bg-black/55 p-1.5 text-white">
                  <Play size={14} />
                </span>
              </span>
            )}
          </a>
        );
      })}
    </div>
  );
}

function DocList({
  assets,
  urlFor,
  onPreview,
}: {
  assets: MediaAsset[];
  urlFor: (id: string | undefined) => string | undefined;
  /** Open a previewable doc in the shared in-app Lightbox. */
  onPreview: (asset: MediaAsset) => void;
}) {
  if (assets.length === 0) {
    return (
      <EmptyState
        icon={<FileText size={22} />}
        title="No documents yet"
        hint="Files that aren't photos or video — PDFs, spreadsheets, archives — collect here."
      />
    );
  }
  return (
    <ul className="m-0 list-none space-y-1 p-0">
      {assets.map((asset) => {
        const { item, messageId, senderName, at } = asset;
        const url = urlFor(item.id);
        const previewable = canPreviewDocInApp(item.mime);
        // Openable only once resolved AND of a type the app can actually
        // render — a type outside canPreviewDocInApp has nowhere in-app to
        // open into (see MediaBubble's FileCard, which carries the full
        // reasoning for why this can no longer fall back to a link: the
        // server forces Content-Disposition: attachment for everything
        // outside its own inline allowlist, so that link was a download
        // wearing an Open label).
        const openable = !!url && previewable;
        const rowClass = `flex items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-surface-2 ${
          url ? "" : "pointer-events-none opacity-50"
        }`;
        const row = (
          <>
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
              <FileText size={16} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium text-fg">{item.name}</span>
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="shrink-0 text-xs text-muted">{prettySize(item.size)}</span>
                <span aria-hidden="true" className="shrink-0 text-xs text-muted">
                  ·
                </span>
                <Shared senderName={senderName} at={at} />
              </span>
              {url && !previewable && (
                <span className="text-xs text-muted">Preview isn&apos;t available for this file type</span>
              )}
            </span>
          </>
        );

        // A type the app can preview itself opens in-app, in the same
        // Lightbox the chat bubble and the Media tab use.
        if (openable) {
          return (
            <li key={`${messageId}:${item.id}`}>
              <button
                type="button"
                onClick={() => onPreview(asset)}
                aria-label={`Open ${item.name}`}
                className={`w-full ${rowClass}`}
              >
                {row}
              </button>
            </li>
          );
        }

        // Not yet resolved, or resolved but not a previewable type: inert
        // either way — never a link, so there is nothing here to download.
        return (
          <li key={`${messageId}:${item.id}`}>
            <div
              className={rowClass}
              aria-label={url ? `${item.name} — preview not available` : undefined}
            >
              {row}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function LinkList({ assets }: { assets: LinkAsset[] }) {
  if (assets.length === 0) {
    return (
      <EmptyState
        icon={<Link2 size={22} />}
        title="No links yet"
        hint="Web addresses posted in this conversation collect here."
      />
    );
  }
  return (
    <ul className="m-0 list-none space-y-1 p-0">
      {assets.map(({ url, messageId, senderName, at }, i) => (
        <li key={`${messageId}:${i}`}>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 rounded-xl px-2 py-2 transition-colors hover:bg-surface-2"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
              <Link2 size={16} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium text-fg">{url}</span>
              <Shared senderName={senderName} at={at} />
            </span>
            <ExternalLink size={14} className="shrink-0 text-muted" />
          </a>
        </li>
      ))}
    </ul>
  );
}
