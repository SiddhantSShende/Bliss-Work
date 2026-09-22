/**
 * The calendar's Filter control.
 *
 * Narrows by things the call rows already carry — what SORT of call it is, and
 * whether the viewer organised it — so opening the menu costs no request and
 * the answer is the same data the grid is already drawn from. Nothing here
 * filters server-side: the window has already bounded the read, and filtering a
 * week in the browser is instant.
 *
 * Follows the app's one popup convention (usePopupDismiss): the wrapper holds
 * both the trigger and the panel, so clicking the trigger closes it rather than
 * closing and immediately reopening.
 */
import { useTranslation } from "react-i18next";
import { Check, Filter } from "lucide-react";
import type { CallDTO } from "@taskboard/shared";
import { usePopupDismiss } from "../lib/usePopupDismiss";
import {
  MEETING_KIND_LABEL,
  NO_MEETING_FILTER,
  isFiltering,
  type MeetingFilter,
} from "../lib/meetingView";

const KINDS: readonly CallDTO["kind"][] = ["MEETING", "CHANNEL", "DIRECT"];

export function MeetingFilterMenu({
  value,
  onChange,
  open,
  onOpenChange,
}: {
  value: MeetingFilter;
  onChange: (next: MeetingFilter) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("meetings");
  const wrap = usePopupDismiss<HTMLDivElement>(open, () => onOpenChange(false));
  const active = isFiltering(value);

  const toggleKind = (kind: CallDTO["kind"]) => {
    const kinds = value.kinds.includes(kind)
      ? value.kinds.filter((k) => k !== kind)
      : [...value.kinds, kind];
    onChange({ ...value, kinds });
  };

  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm font-medium transition-colors ${
          active
            ? "border-accent/40 bg-accent-soft text-accent"
            : "border-border bg-surface text-fg hover:bg-surface-2"
        }`}
      >
        <Filter size={15} />
        <span className="hidden sm:inline">{t("filterMenu.trigger")}</span>
        {active && <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />}
      </button>

      {open && (
        <div
          role="menu"
          aria-label={t("filterMenu.ariaLabel")}
          className="absolute right-0 z-40 mt-1.5 w-56 rounded-xl border border-border bg-surface p-1.5 shadow-card"
        >
          <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
            {t("filterMenu.typeHeading")}
          </p>
          {KINDS.map((kind) => (
            <MenuCheck
              key={kind}
              label={MEETING_KIND_LABEL[kind]}
              // An empty selection means every kind, so every box reads as
              // ticked until one is deliberately chosen.
              checked={value.kinds.length === 0 || value.kinds.includes(kind)}
              onClick={() => toggleKind(kind)}
            />
          ))}
          <div className="my-1 border-t border-border/60" />
          <MenuCheck
            label={t("filterMenu.onlyMine")}
            checked={value.mineOnly}
            onClick={() => onChange({ ...value, mineOnly: !value.mineOnly })}
          />
          {active && (
            <button
              type="button"
              onClick={() => onChange(NO_MEETING_FILTER)}
              className="mt-1 w-full rounded-lg px-2 py-1.5 text-left text-sm font-medium text-accent hover:bg-accent-soft"
            >
              {t("filterMenu.clear")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function MenuCheck({
  label,
  checked,
  onClick,
}: {
  label: string;
  checked: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-fg transition-colors hover:bg-surface-2"
    >
      <span
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
          checked ? "border-accent bg-accent text-accent-fg" : "border-border bg-surface"
        }`}
        aria-hidden
      >
        {checked && <Check size={11} strokeWidth={3} />}
      </span>
      {label}
    </button>
  );
}
