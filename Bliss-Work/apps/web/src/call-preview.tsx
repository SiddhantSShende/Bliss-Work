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
import { Avatar, Button } from "@taskboard/ui";
import { CallControls } from "../../../packages/app/src/features/CallControls";
import { ScreenSharePopup } from "../../../packages/app/src/features/ScreenSharePopup";
import "@taskboard/ui/styles.css";
import "./index.css";

/** The call started a couple of minutes ago, so the timer shows something. */
const CONNECTED_AT = Date.now() - 138_000;

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
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
