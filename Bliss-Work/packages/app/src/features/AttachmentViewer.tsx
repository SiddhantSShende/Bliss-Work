import type { MediaItem } from "../lib/chatEnvelope";
import { attachmentCapability } from "../lib/attachmentCapability";
import { DocumentViewer } from "./document-viewer/DocumentViewer";
import { Lightbox } from "./Lightbox";

/**
 * The one viewer every surface opens attachments in (Mail, chats, channels, the
 * chat assets sheet). It chooses between the two without either knowing about the
 * other:
 *
 *   - a Word / PowerPoint / Excel / CSV / .txt item → the new DocumentViewer;
 *   - anything else → the existing Lightbox, passed exactly the props it always
 *     got. Lightbox itself is untouched, so images, video, PDFs and plain text
 *     behave as they always did, gallery navigation included.
 *
 * A document is shown on its own, never inside a gallery: callers open it as a
 * single-item list, so ←/→ can never land on an Office file the Lightbox cannot
 * draw.
 *
 * `onDownload` is the surface's OWN audited download (chat's `downloadItem`, Mail's
 * `useMailAttachmentDownload`); the viewer calls it only from its "can't be
 * previewed" panel, so Download stays one path per surface.
 */
export function AttachmentViewer({
  items,
  index,
  urlFor,
  onClose,
  onIndexChange,
  onDownload,
}: {
  items: MediaItem[];
  index: number;
  urlFor: (id: string | undefined) => string | undefined;
  onClose: () => void;
  onIndexChange: (next: number) => void;
  onDownload?: (item: MediaItem) => void;
}) {
  const current = items[index];
  const cap = current ? attachmentCapability({ name: current.name, mime: current.mime, size: current.size }) : undefined;
  if (current && cap?.kind === "document") {
    return <DocumentViewer item={current} url={urlFor(current.id)} mode={cap.mode} onClose={onClose} onDownload={onDownload} />;
  }
  return <Lightbox items={items} index={index} urlFor={urlFor} onClose={onClose} onIndexChange={onIndexChange} />;
}
