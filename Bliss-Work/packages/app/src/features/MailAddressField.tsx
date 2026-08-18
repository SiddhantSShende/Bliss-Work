import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X, AlertCircle } from "lucide-react";
import { Avatar } from "@taskboard/ui";
import { isValidMailAddress, normalizeMailAddress, splitMailAddresses } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { matchUser } from "../lib/matchUser";

/**
 * One recipient row of the composer (To, Cc or Bcc): committed addresses as
 * chips, plus a typeahead over the org directory.
 *
 * Addresses are committed on Enter, comma, semicolon, Tab and blur, and a paste
 * is split on the separators other mail clients produce — so a list copied out
 * of somewhere else becomes chips rather than one unusable token.
 *
 * An address that fails validation is still ADDED, as a red chip. Refusing to
 * accept it would silently swallow the user's typing and leave them staring at
 * an empty field wondering what they did wrong; showing it as wrong lets them
 * fix the character they got wrong. Send stays disabled while any chip is red.
 */
export function MailAddressField({
  label,
  value,
  onChange,
  placeholder,
  autoFocus,
}: {
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const { api } = useRuntime();
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: users = [] } = useQuery({ queryKey: qk.directory, queryFn: () => api.directory() });

  const add = (raw: string) => {
    const parts = splitMailAddresses(raw);
    if (parts.length === 0) return;
    const next = [...value];
    for (const part of parts) {
      // Normalized when valid so the chip matches what the server will store;
      // kept verbatim when not, so the user can see the typo they made.
      const addr = normalizeMailAddress(part) || part;
      if (!next.includes(addr)) next.push(addr);
    }
    onChange(next);
    setDraft("");
  };

  const remove = (addr: string) => onChange(value.filter((a) => a !== addr));

  const suggestions = useMemo(() => {
    const q = draft.trim();
    if (!q) return [];
    return users
      .filter((u) => u.email && !value.includes(u.email.toLowerCase()))
      .filter((u) => matchUser(u, q))
      .slice(0, 6);
  }, [users, draft, value]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "," || e.key === ";" || e.key === "Tab") {
      if (!draft.trim()) return; // Tab with an empty field must still move focus.
      e.preventDefault();
      add(draft);
      return;
    }
    // Backspace on an empty field pulls the last chip back into the input for
    // editing rather than deleting it outright — the address is usually
    // ALMOST right, and re-typing all of it to fix one character is the thing
    // this avoids.
    if (e.key === "Backspace" && !draft && value.length > 0) {
      e.preventDefault();
      const last = value[value.length - 1]!;
      onChange(value.slice(0, -1));
      setDraft(last);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium text-fg/80">{label}</span>
      <div
        onClick={() => inputRef.current?.focus()}
        className="flex min-h-11 w-full flex-wrap items-center gap-1.5 rounded-xl border border-border bg-surface px-2.5 py-2 text-sm focus-within:ring-2 focus-within:ring-accent/40"
      >
        {value.map((addr) => {
          const bad = !isValidMailAddress(addr);
          return (
            <span
              key={addr}
              title={bad ? "This does not look like an email address" : addr}
              className={`inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
                bad ? "bg-danger/12 text-danger" : "bg-accent-soft text-accent"
              }`}
            >
              {bad && <AlertCircle size={11} className="shrink-0" />}
              <span className="truncate">{addr}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  remove(addr);
                }}
                aria-label={`Remove ${addr}`}
                className="shrink-0 hover:opacity-70"
              >
                <X size={11} />
              </button>
            </span>
          );
        })}
        <input
          ref={inputRef}
          value={draft}
          autoFocus={autoFocus}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          // Commit whatever is half-typed when focus leaves. Pressing Send with
          // an uncommitted address in the box would otherwise drop it silently.
          // Delayed so a click on a suggestion lands before the list unmounts.
          onBlur={() => {
            window.setTimeout(() => setFocused(false), 120);
            if (draft.trim()) add(draft);
          }}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text");
            if (!/[,;\s]/.test(text)) return; // single address — let it type through
            e.preventDefault();
            add(text);
          }}
          placeholder={value.length === 0 ? placeholder : ""}
          className="min-w-32 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-muted"
          aria-label={label}
        />
      </div>

      {focused && suggestions.length > 0 && (
        <div className="max-h-44 overflow-auto rounded-xl border border-border bg-surface p-1 shadow-soft">
          {suggestions.map((u) => (
            <button
              type="button"
              key={u.id}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                add(u.email);
                inputRef.current?.focus();
              }}
              className="flex w-full items-center gap-2.5 rounded-lg p-2 text-left hover:bg-surface-2"
            >
              <Avatar name={u.displayName} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-fg">{u.displayName}</span>
                <span className="block truncate text-xs text-muted">{u.email}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
