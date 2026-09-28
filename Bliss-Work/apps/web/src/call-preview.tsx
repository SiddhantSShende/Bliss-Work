/**
 * DEV-ONLY preview of the in-call controls — served at /call-preview.html by
 * `npm run web`, and absent from every production build (Vite's build input is
 * index.html alone).
 *
 * The real surface needs the whole stack up, two signed-in accounts and a ring
 * between them. This mounts the SAME components against local state so the five
 * controls, the red sharing indicator and the sliding panel can be looked at and
 * clicked. Nothing here is imported by the app.
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Avatar, Button, cn } from "@taskboard/ui";
import { CallControls } from "../../../packages/app/src/features/CallControls";
import { ScreenSharePopup } from "../../../packages/app/src/features/ScreenSharePopup";
import { CallSidebar } from "../../../packages/app/src/features/CallSidebar";
import { BracketFrame } from "../../../packages/app/src/features/BracketFrame";
import { CallTile } from "../../../packages/app/src/features/CallTile";
import { CallSpeakerFilmstrip } from "../../../packages/app/src/features/CallSpeakerFilmstrip";
import { CallSidePanel } from "../../../packages/app/src/features/CallSidePanel";
import { CallChat } from "../../../packages/app/src/features/CallChat";
import { CallNotes } from "../../../packages/app/src/features/CallNotes";
import { CallRoster } from "../../../packages/app/src/features/CallRoster";
import "@taskboard/ui/styles.css";
import "./index.css";

/** The call started a couple of minutes ago, so the timer shows something. */
const CONNECTED_AT = Date.now() - 138_000;

const NAMES = ["Alice Chen", "Bob Diaz", "Carol Wu", "David Kim", "Eve Novak"];
function makeParticipants(sharerIndex: number | null = null) {
  return [
    { identity: "me", name: "Me", isLocal: true, speaking: false, micOn: true, camOn: false, sharing: false, videoTrack: null, screenTrack: null, audioTrack: null },
    ...NAMES.map((name, i) => ({
      identity: `p${i}`, name, isLocal: false, speaking: i === 0 && sharerIndex === null, micOn: i % 3 !== 0, camOn: false,
      sharing: i === sharerIndex, videoTrack: null, screenTrack: null, audioTrack: null,
    })),
  ];
}

function NeonRoomPreview() {
  const [scenario, setScenario] = useState("speaking");
  const [panel, setPanel] = useState<"chat" | "notes" | "participants" | null>(null);
  const participants = makeParticipants(scenario === "sharing" ? 1 : null);
  // NAMES is a fixed 5-element array, so makeParticipants() always returns 6
  // entries — index 1 is guaranteed to exist. noUncheckedIndexedAccess can't
  // see that through the .map() call, hence the assertion.
  const stage = participants.find((p) => p.sharing) ?? participants[1]!;

  return (
    <section className="mx-auto mt-10 max-w-6xl">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
          Futuristic redesign — CallSidebar + BracketFrame
        </h2>
        <div className="flex gap-2">
          <Button size="sm" variant={scenario === "speaking" ? "primary" : "ghost"} onClick={() => setScenario("speaking")}>
            Speaking (vertical filmstrip)
          </Button>
          <Button size="sm" variant={scenario === "sharing" ? "primary" : "ghost"} onClick={() => setScenario("sharing")}>
            Screen share (horizontal filmstrip)
          </Button>
        </div>
      </div>
      <div className="meeting-theme meeting-mesh relative overflow-hidden rounded-3xl" style={{ height: 720 }}>
        <div className="flex h-full">
          <CallSidebar
            micOn camOn={false} sharing={scenario === "sharing"}
            onToggleMic={() => {}} onToggleCam={() => {}} onToggleShare={() => {}}
            handRaised={false} canRaiseHand onToggleHand={() => {}}
            participantsActive={panel === "participants"} onToggleParticipants={() => setPanel((p) => (p === "participants" ? null : "participants"))}
            canAddPeople addPeopleTitle="Add people" onAddPeople={() => {}}
            canInviteLink inviteLinkTitle="Copy invite link" mintingInviteLink={false} onCopyInviteLink={() => {}}
            chatActive={panel === "chat"} unreadChat={3} onToggleChat={() => setPanel((p) => (p === "chat" ? null : "chat"))}
            notesActive={panel === "notes"} onToggleNotes={() => setPanel((p) => (p === "notes" ? null : "notes"))}
            isHost recordingSupported recording={false} onToggleRecording={() => {}}
            pipSupported pipActive={false} onTogglePip={() => {}} onMinimize={() => {}}
            onEnd={() => {}}
          />
          <div className="flex min-h-0 flex-1 flex-col">
            <header className="shrink-0 px-6 py-4">
              <div className="truncate text-base font-semibold uppercase tracking-wide text-fg">Project Aurora — Sync Call</div>
              <div className="mt-1 text-xs text-muted">{participants.length} Participants Present</div>
            </header>
            <div className="flex min-h-0 flex-1 gap-4 px-6 pb-6">
              <main className="flex min-h-0 flex-1 flex-col gap-3">
                <div className={cn("flex min-h-0 flex-1 gap-3", scenario === "sharing" ? "flex-col" : "flex-row")}>
                  <BracketFrame className="glass relative min-h-0 flex-1">
                    <CallTile p={stage} size="stage" active />
                  </BracketFrame>
                  <CallSpeakerFilmstrip
                    participants={participants} activeId={stage.identity} hands={new Set()} pinned={null} onTogglePin={() => {}}
                    orientation={scenario === "sharing" ? "horizontal" : "vertical"}
                    limit={scenario === "sharing" ? 4 : 3}
                  />
                </div>
              </main>
              {panel && (
                <CallSidePanel
                  active={panel} onSelectTab={setPanel} onClose={() => setPanel(null)}
                  onExport={panel === "chat" ? () => {} : panel === "notes" ? () => {} : undefined}
                  unreadChat={3}
                  className="h-full w-72 shrink-0 xl:w-80"
                >
                  {panel === "chat" ? (
                    <CallChat chat={[]} participants={participants} me="me" onSend={() => {}} />
                  ) : panel === "notes" ? (
                    <CallNotes notes={[]} onAdd={() => {}} />
                  ) : (
                    <CallRoster participants={participants} hands={new Set()} pinned={null} onTogglePin={() => {}} />
                  )}
                </CallSidePanel>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Preview() {
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [dark, setDark] = useState(false);

  document.documentElement.className = dark ? "dark" : "light";

  return (
    <div className="min-h-screen bg-bg p-6 text-fg">
      <header className="mx-auto mb-6 flex max-w-3xl items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">In-call controls</h1>
          <p className="text-sm text-muted">
            Press <strong>Share Screen</strong> to see the red indicator and the sliding panel.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setDark((d) => !d)}>
          {dark ? "Light" : "Dark"} theme
        </Button>
      </header>

      {/* The 1:1 overlay, as CallUI lays it out. */}
      <section className="mx-auto mb-8 max-w-3xl">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
          Chat call (CallUI)
        </h2>
        <div className="relative flex h-[520px] flex-col items-center justify-center gap-6 rounded-3xl bg-black/80 p-6">
          <Avatar name="Shristi Sharma" size="lg" />

          {sharing && (
            <ScreenSharePopup startedAt={CONNECTED_AT} onStop={() => setSharing(false)} />
          )}

          <div className="z-10 mt-auto text-center text-white drop-shadow">
            <div className="text-xl font-semibold">Shristi Sharma</div>
            <div className="text-sm opacity-80">Connected</div>
          </div>

          <div className="z-10 mb-2">
            <CallControls
              micOn={micOn}
              camOn={camOn}
              sharing={sharing}
              startedAt={CONNECTED_AT}
              onAddPeople={() => alert("Opens the teammate picker")}
              onToggleShare={() => setSharing((s) => !s)}
              onToggleMic={() => setMicOn((m) => !m)}
              onToggleCam={() => setCamOn((c) => !c)}
              onEnd={() => alert("Hangs up")}
            />
          </div>
        </div>
      </section>

      {/* The same five, on the room's footer. */}
      <section className="mx-auto max-w-3xl">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
          Group call footer (CallRoom)
        </h2>
        <div className="overflow-hidden rounded-2xl border border-border bg-surface">
          <div className="relative flex h-56 items-center justify-center text-sm text-muted">
            participant grid
            {sharing && (
              <ScreenSharePopup startedAt={CONNECTED_AT} onStop={() => setSharing(false)} />
            )}
          </div>
          <div className="border-t border-border/70 px-5 py-3">
            <CallControls
              variant="surface"
              micOn={micOn}
              camOn={camOn}
              sharing={sharing}
              startedAt={CONNECTED_AT}
              canAddPeople={false}
              addPeopleTitle="Everyone in the channel is already invited"
              onAddPeople={() => {}}
              onToggleShare={() => setSharing((s) => !s)}
              onToggleMic={() => setMicOn((m) => !m)}
              onToggleCam={() => setCamOn((c) => !c)}
              onEnd={() => alert("Leaves the room")}
            />
          </div>
        </div>
      </section>

      <NeonRoomPreview />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
