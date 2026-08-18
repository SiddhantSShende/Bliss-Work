/**
 * Fixture for scripts/chat-drop-check.ts — the real chat composer, in a real
 * browser, with a stub server behind it.
 *
 * It mounts the PRODUCTION pieces (`useChatMedia` + `Composer` + the real
 * `ApiClient` via `RuntimeProvider`) wired exactly as DMView, ChannelView and
 * InboxThread wire them. Nothing about the drop path is re-implemented here;
 * only the server it talks to is fake.
 *
 * Why a browser at all: jsdom has no drag-and-drop. `fireEvent.drop` there
 * invents an event and hands it straight to React, so it cannot observe the
 * part that actually decides whether a drop is accepted — whether `dragover`
 * was cancelled — and it cannot exercise a real `DataTransfer`, whose FileList
 * is neutered the moment the handler returns. A unit test passing therefore
 * says very little about what a user gets.
 *
 * `window.__sent` records every message the composer emitted. A drop must leave
 * it empty.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// Relative, not "@taskboard/app/...": the package exports only its entry
// points, and this fixture deliberately reaches for the internals under test.
import { RuntimeProvider } from "../../../packages/app/src/lib/runtime";
import { Composer } from "../../../packages/app/src/features/Composer";
import { useChatMedia } from "../../../packages/app/src/features/useChatMedia";
import { useSession } from "../../../packages/app/src/store/session";
import { FileTransferProvider } from "../../../packages/app/src/lib/fileTransfer";

declare global {
  interface Window {
    __sent: string[];
  }
}
window.__sent = [];

const SCOPE_ID = "018f0000-0000-7000-8000-000000000001";
const base = location.origin;

/** Only the fields the chat media path actually reads. */
const config = {
  kind: "web" as const,
  authBase: base,
  taskBase: base,
  messagingBase: base,
  integrationsBase: base,
  telemetryBase: base,
  notificationBase: base,
  wsUrl: base.replace(/^http/, "ws") + "/ws",
  persistToken: () => {},
  getRefreshToken: () => null,
};

function Harness() {
  const media = useChatMedia({
    scope: "thread",
    scopeId: SCOPE_ID,
    meId: "me",
    send: (body: string) => window.__sent.push(body),
  });
  return (
    <div data-testid="dropzone" style={{ height: "100vh" }} {...media.dropzone}>
      <Composer
        onSend={media.flushStaged}
        onAttach={media.onAttach}
        onShareLocation={media.onShareLocation}
        onPaste={media.onPaste}
        dragging={media.dragging}
        attachments={media.staged}
        onRemoveAttachment={media.removeStaged}
        uploading={Object.keys(media.uploads).length}
      />
      <input data-testid="file-input" {...media.fileInputProps} />
      {media.overlay}
    </div>
  );
}

useSession.setState({ accessToken: "test-token" });

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RuntimeProvider config={config as never}>
        <FileTransferProvider>
          <Harness />
        </FileTransferProvider>
      </RuntimeProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
