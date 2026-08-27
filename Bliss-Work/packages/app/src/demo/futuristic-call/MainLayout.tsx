import { useState } from "react";
import { cn } from "@taskboard/ui";
import { Header } from "./Header";
import { Sidebar } from "./Sidebar";
import { VideoFeed } from "./VideoFeed";
import { ChatPanel } from "./ChatPanel";
import { MOCK_MESSAGES, MOCK_PARTICIPANTS } from "./mockData";

/**
 * Standalone reference build of the spec's two layouts — Layout A (active
 * speaker) and Layout B (screen share + chat). Wired to mock data only; the
 * real, live version of this surface is CallRoom.tsx.
 */
export function MainLayout() {
  const [layout, setLayout] = useState<"speaker" | "screenshare">("speaker");
  const [chatOpen, setChatOpen] = useState(true);

  const [stageParticipant, ...otherParticipants] = MOCK_PARTICIPANTS;

  return (
    <div className="meeting-theme meeting-mesh fixed inset-0 flex text-fg">
      <Sidebar chatActive={chatOpen} unreadChat={chatOpen ? 0 : 2} onToggleChat={() => setChatOpen((v) => !v)} onEndCall={() => {}} />

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-start justify-between gap-4 px-6 py-4">
          <Header participantCount={MOCK_PARTICIPANTS.length} />

          {/* Demo-only control — swaps which of the spec's two layouts is on screen. */}
          <div className="flex shrink-0 gap-1 rounded-full border border-border/70 bg-surface-2 p-1 text-xs">
            <button
              type="button"
              onClick={() => setLayout("speaker")}
              className={cn(
                "rounded-full px-3 py-1.5 font-medium transition-colors",
                layout === "speaker" ? "bg-accent text-accent-fg" : "text-muted hover:text-fg",
              )}
            >
              Speaker view
            </button>
            <button
              type="button"
              onClick={() => setLayout("screenshare")}
              className={cn(
                "rounded-full px-3 py-1.5 font-medium transition-colors",
                layout === "screenshare" ? "bg-accent text-accent-fg" : "text-muted hover:text-fg",
              )}
            >
              Screen share
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 px-6 pb-6 lg:flex-row">
          <main className="flex min-h-0 flex-1 flex-col gap-3">
            <VideoFeed layout={layout} stageParticipant={stageParticipant} otherParticipants={otherParticipants} />
          </main>
          {chatOpen && <ChatPanel messages={MOCK_MESSAGES} className="w-full shrink-0 lg:w-80" />}
        </div>
      </div>
    </div>
  );
}
