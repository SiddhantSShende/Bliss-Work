/**
 * Find a message in the conversation you are standing in.
 *
 * A strip under the header rather than a dialog: the results ARE the thread —
 * typing narrows the message list in place — so covering the thread with a
 * panel would hide the only thing worth looking at.
 *
 * It reports the match count against the number of messages actually loaded,
 * because that is the honest bound: the server holds message bodies encrypted
 * and cannot search them, so this searches what the reader has. Pulling in
 * older history widens it, and the count says so.
 */
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Search, X } from "lucide-react";

export function ChatSearchBar({
  value,
  onChange,
  onClose,
  matches,
  loaded,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  onClose: () => void;
  /** Messages matching the current query. */
  matches: number;
  /** Messages this thread has loaded — the set being searched. */
  loaded: number;
  placeholder?: string;
}) {
  const { t } = useTranslation("chatList");
  const effectivePlaceholder = placeholder ?? t("chatSearchBar.placeholder");
  const inputRef = useRef<HTMLInputElement>(null);

  // Opened from a menu row, so the pointer is nowhere near this field and the
  // next thing the user does is type.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border/70 bg-surface/60 px-5 py-2 backdrop-blur">
      <div className="relative min-w-0 flex-1">
        <Search
          size={14}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
        />
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          // Escape closes the search, not the app shell behind it.
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              onClose();
            }
          }}
          placeholder={effectivePlaceholder}
          aria-label={t("chatSearchBar.ariaLabel")}
          className={`w-full rounded-lg border border-border bg-surface-2 py-1.5 pl-9 text-sm text-fg outline-none focus:border-accent ${value ? "pr-9" : "pr-3"}`}
        />
        {value && (
          <button
            type="button"
            onClick={() => onChange("")}
            title={t("chatSearchBar.clearSearch")}
            aria-label={t("chatSearchBar.clearSearch")}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted hover:bg-surface hover:text-fg"
          >
            <X size={13} />
          </button>
        )}
      </div>
      {/* Hidden until there is a query, so an empty field does not announce
          "0 results" at someone who has not typed anything yet. */}
      {value.trim() && (
        <span className="shrink-0 text-xs text-muted">
          {matches === 0 ? t("chatSearchBar.noMatches") : t("chatSearchBar.matchesOfLoaded", { matches, loaded })}
        </span>
      )}
      <button
        type="button"
        onClick={onClose}
        title={t("chatSearchBar.closeSearch")}
        aria-label={t("chatSearchBar.closeSearch")}
        className="shrink-0 rounded-lg p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
      >
        <X size={15} />
      </button>
    </div>
  );
}
