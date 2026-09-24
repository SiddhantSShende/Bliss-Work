import { useState } from "react";
import { Button } from "@taskboard/ui";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

/**
 * Shown exactly once, right after enrollment or a regeneration — the server
 * never returns a backup code again after this response. Requires an explicit
 * "I've saved these" acknowledgement rather than a plain close button, since
 * closing it accidentally is unrecoverable (short of disabling and
 * re-enrolling).
 */
export function BackupCodesView({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { t } = useTranslation("account");
  const [copied, setCopied] = useState(false);
  const [ack, setAck] = useState(false);

  const copyAll = async () => {
    const text = codes.join("\n");
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        try {
          textarea.select();
          if (!document.execCommand("copy")) throw new Error("Clipboard copy failed");
        } finally {
          textarea.remove();
        }
      }
      setCopied(true);
    } catch {
      toast.error(t("account:backupCodesView.copyFailed"));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">{t("account:backupCodesView.description")}</p>
      <div className="grid grid-cols-2 gap-2 rounded-lg bg-surface-2 p-4 font-mono text-sm">
        {codes.map((code) => (
          <span key={code} className="select-all text-fg">
            {code}
          </span>
        ))}
      </div>
      <Button type="button" variant="subtle" size="sm" onClick={copyAll} className="self-start">
        {copied ? <Check size={14} /> : <Copy size={14} />}
        {copied ? t("account:backupCodesView.copied") : t("account:backupCodesView.copyAll")}
      </Button>
      <label className="flex items-start gap-2 text-sm text-fg">
        <input
          type="checkbox"
          checked={ack}
          onChange={(e) => setAck(e.target.checked)}
          className="mt-0.5"
        />
        {t("account:backupCodesView.acknowledgeLabel")}
      </label>
      <Button size="lg" disabled={!ack} onClick={onDone} className="w-full">
        {t("account:backupCodesView.done")}
      </Button>
    </div>
  );
}
