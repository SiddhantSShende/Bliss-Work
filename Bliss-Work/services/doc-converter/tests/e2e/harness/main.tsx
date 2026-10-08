import "../packages/app/src/i18n";
import { createRoot } from "react-dom/client";
import { AttachmentViewer } from "../packages/app/src/features/AttachmentViewer";

// One real AttachmentViewer, pointed at a signed URL from the real messaging-svc.
// Parameters ride in the URL fragment: Vite refuses a request whose QUERY looks like a path
// outside its serving root (the signed URL has slashes), but never sees a fragment.
const q = new URLSearchParams(location.hash.slice(1));
const item = {
  id: q.get("id") ?? "x",
  name: q.get("name") ?? "file",
  size: Number(q.get("size") ?? 1234),
  mime: q.get("mime") ?? "application/octet-stream",
};
const w = window as unknown as { __downloads: string[]; __closed: boolean };
w.__downloads = [];
w.__closed = false;
createRoot(document.getElementById("root")!).render(
  <AttachmentViewer
    items={[item]}
    index={0}
    urlFor={() => q.get("url") ?? undefined}
    onClose={() => (w.__closed = true)}
    onIndexChange={() => {}}
    onDownload={(i) => w.__downloads.push(i.name)}
  />,
);
