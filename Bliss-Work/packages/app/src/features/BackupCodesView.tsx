import { useState } from "react";
import { Button } from "@taskboard/ui";
import { Check, Copy } from "lucide-react";

/**
 * Shown exactly once, right after enrollment or a regeneration — the server
 * never returns a backup code again after this response. Requires an explicit
 * "I've saved these" acknowledgement rather than a plain close button, since
 * closing it accidentally is unrecoverable (short of disabling and
 * re-enrolling).
 */
export function BackupCodesView({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const [ack, setAck] = useState(false);

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
    } catch {
      // Clipboard access can be denied/unavailable — the codes are still
      // selectable text below, so this is a convenience, not the only path.
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        Save these backup codes somewhere safe. Each one lets you sign in ONE time if you lose access to
        your authenticator — they will not be shown again.
      </p>
      <div className="grid grid-cols-2 gap-2 rounded-lg bg-surface-2 p-4 font-mono text-sm">
        {codes.map((code) => (
          <span key={code} className="select-all text-fg">
            {code}
          </span>
        ))}
      </div>
      <Button variant="subtle" size="sm" onClick={copyAll} className="self-start">
        {copied ? <Check size={14} /> : <Copy size={14} />}
        {copied ? "Copied" : "Copy all"}
      </Button>
      <label className="flex items-start gap-2 text-sm text-fg">
        <input
          type="checkbox"
          checked={ack}
          onChange={(e) => setAck(e.target.checked)}
          className="mt-0.5"
        />
        I've saved these codes somewhere safe.
      </label>
      <Button size="lg" disabled={!ack} onClick={onDone} className="w-full">
        Done
      </Button>
    </div>
  );
}
