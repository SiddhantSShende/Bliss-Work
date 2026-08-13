import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BookUser, ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button, Input } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { formatE164, normalizeE164, waForwardText, waLink } from "../lib/waLink";
import { contactsPicker, pickContact } from "../lib/contactPicker";

/**
 * Forward a message to a WhatsApp contact by DEEP LINK.
 *
 * The distinction from the External tab is what each can promise. That one
 * sends server-side through a connected WhatsApp BUSINESS account and records
 * the forward only once Meta accepted it. This one needs no connected account
 * at all — it opens the user's own WhatsApp with the message prefilled — and in
 * exchange we never learn whether they pressed send. Everything below is worded
 * to match: we record that WhatsApp was opened, not that anything was sent.
 *
 * Two browser rules shape the flow, and they pull against each other:
 *
 *   1. navigator.contacts.select() must be called synchronously inside a user
 *      gesture, and consumes it.
 *   2. A popup opened after an await is blocked.
 *
 * So one click cannot both pick a contact and open WhatsApp. The answer is two
 * gestures, and making the second one an anchor rather than a scripted open:
 * a user-initiated <a target="_blank"> is never popup-blocked, and in Electron
 * it goes through setWindowOpenHandler → safeExternalUrl → shell.openExternal,
 * so the desktop app hands off to the system browser and never opens a renderer
 * window. The forward is recorded on the same click, but never awaited before
 * navigation — a slow or failing POST must not stop WhatsApp from opening.
 */
export function WhatsAppForward({
  sourceMessageId,
  sourceBody,
  onDone,
}: {
  sourceMessageId: string | null;
  sourceBody: string;
  onDone: () => void;
}) {
  const { api } = useRuntime();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recorded = useRef(false);

  const picker = contactsPicker();
  const digits = normalizeE164(phone);
  const showPhoneError = phone.trim().length > 0 && digits === null;
  const waUrl = digits ? waLink(digits, waForwardText(sourceBody)) : null;

  useEffect(() => {
    setName("");
    setPhone("");
    setError(null);
    setBusy(false);
    recorded.current = false;
  }, [sourceMessageId]);

  // Gesture 1. The picker call is the FIRST statement — anything awaited before
  // it would spend the user activation it requires.
  const choose = async () => {
    setError(null);
    const c = await pickContact(picker);
    if (!c) return;
    if (c.name) setName(c.name);
    if (c.phone) setPhone(c.phone);
  };

  // Gesture 2's side effect. Deliberately not awaited by the anchor's onClick:
  // navigation must not depend on this succeeding.
  const record = async () => {
    if (!sourceMessageId || !digits || recorded.current) return;
    recorded.current = true;
    setBusy(true);
    try {
      await api.forwardMessageLink(sourceMessageId, digits, name.trim() || undefined);
      // queryBridge drops the WS echo of our own message.created (the composer
      // renders those optimistically), and this entry never went through the
      // composer — so nothing refreshes the thread unless we ask.
      void qc.invalidateQueries({ queryKey: qk.conversations });
      void qc.invalidateQueries({ queryKey: ["messages"] });
      void qc.invalidateQueries({ queryKey: ["channelMessages"] });
      void qc.invalidateQueries({ queryKey: ["forwardActivity"] });
      onDone();
    } catch {
      recorded.current = false;
      toast.error("Couldn't log the forward", {
        description: "WhatsApp still opened — it just isn't in your forwarding activity.",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        Opens WhatsApp with the message ready to send — you still press send there. No
        WhatsApp Business connection needed.
      </p>

      {picker && (
        <Button variant="secondary" size="sm" className="w-full" onClick={choose}>
          <BookUser size={14} /> Choose from contacts
        </Button>
      )}

      {error && (
        <div className="rounded-xl bg-danger-soft px-3 py-2 text-xs text-danger">{error}</div>
      )}

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-muted">Name (optional)</span>
        <Input placeholder="Jane Doe" value={name} onChange={(e) => setName(e.target.value)} />
      </label>

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-muted">Phone number</span>
        <Input
          type="tel"
          inputMode="tel"
          placeholder="+1 555 019 2834"
          aria-label="Phone number"
          aria-invalid={showPhoneError || undefined}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
        <span className="mt-1 block text-[11px] text-muted">
          {showPhoneError ? (
            <span className="text-danger">
              Include the country code — WhatsApp can&apos;t resolve a local number.
            </span>
          ) : digits ? (
            `Will open a chat with ${formatE164(digits)}`
          ) : (
            "Include the country code, e.g. +1 for the US."
          )}
        </span>
      </label>

      <div className="flex items-center justify-end gap-2">
        {busy && <Loader2 size={14} className="animate-spin text-muted" aria-label="Saving" />}
        <a
          href={waUrl ?? undefined}
          target="_blank"
          rel="noopener noreferrer"
          // An <a> without href has no implicit role, so without this the
          // control disappears from the accessibility tree exactly while it is
          // disabled — leaving a screen-reader user with no way to find out
          // what they are waiting on. Explicit role + aria-disabled keeps it
          // announced as a link that is not yet actionable.
          role="link"
          aria-disabled={!waUrl}
          onClick={(e) => {
            if (!waUrl) {
              e.preventDefault();
              return;
            }
            void record();
          }}
          className={`inline-flex h-8 items-center gap-2 rounded-xl bg-gradient-to-br from-brand-from to-brand-to px-3 text-[13px] font-medium text-accent-fg transition-opacity ${
            waUrl ? "" : "pointer-events-none opacity-50"
          }`}
        >
          <ExternalLink size={14} /> Open WhatsApp
        </a>
      </div>

      {waUrl && (
        <p className="break-all text-[11px] text-muted/80">
          If nothing opens, copy this link: <span className="select-all">{waUrl}</span>
        </p>
      )}
    </div>
  );
}
