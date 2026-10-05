import { useId, useState } from "react";
import { ChevronUp, Plus, X } from "lucide-react";

/** One selected thing, shown as a removable chip. */
export interface SelectionChip {
  id: string;
  label: string;
  /** An avatar or icon shown before the label. */
  leading?: React.ReactNode;
}

/** "light" is the meeting form's own hardcoded white card; "theme" follows the
 *  user's chosen theme, like the rest of the app — for a caller whose
 *  surrounding form is NOT a white card (CreateTaskDialog's Modal, in
 *  particular). Same distinction, same naming, as pickerTone.ts. */
export type SelectionFieldTone = "light" | "theme";

const SELECTION_FIELD_TONES: Record<SelectionFieldTone, {
  label: string;
  empty: string;
  chip: string;
  chipRemove: string;
  toggle: string;
}> = {
  light: {
    label: "text-gray-700",
    empty: "text-gray-500",
    chip: "border-gray-200 bg-gray-50 text-gray-800",
    chipRemove: "text-gray-400 hover:bg-gray-200 hover:text-gray-700",
    toggle: "border-gray-300 bg-white text-gray-700 hover:bg-gray-50",
  },
  theme: {
    label: "text-fg",
    empty: "text-muted",
    chip: "border-border bg-surface-2 text-fg",
    chipRemove: "text-muted hover:bg-border hover:text-fg",
    toggle: "border-border bg-surface text-fg hover:bg-surface-2",
  },
};

/**
 * A multi-select FIELD for a form: what is selected, as removable chips, and a
 * button that opens the picker for choosing more.
 *
 * Generic on purpose — the meeting form has two of these (members, channels) and
 * they differ only in what the chips are and which picker opens. The picker is a
 * child, mounted only while open, so it can move focus to its own search box when
 * the user opens it, and costs nothing while closed.
 *
 * Keyboard: the chips' remove buttons and the toggle are ordinary buttons, in
 * reading order. Closing the picker leaves focus on the toggle the user pressed.
 *
 * Painted for the meeting form's white card, like the rest of that form.
 */
export function SelectionField({
  label,
  count,
  hint,
  chips,
  onRemove,
  removeLabel,
  emptyLabel,
  addLabel,
  doneLabel,
  children,
  tone = "light",
}: {
  label: string;
  /** Shown beside the label — "People (3)". Kept outside the label element so the
   *  group's accessible name stays just "People". */
  count?: number;
  hint?: string;
  chips: SelectionChip[];
  onRemove: (id: string) => void;
  /** The accessible name of a chip's remove button — "Remove Ada". Icons alone are
   *  not a name. */
  removeLabel: (chip: SelectionChip) => string;
  emptyLabel: string;
  addLabel: string;
  doneLabel: string;
  /** The picker. Rendered only while open. */
  children: React.ReactNode;
  tone?: SelectionFieldTone;
}) {
  const [open, setOpen] = useState(false);
  const labelId = useId();
  const panelId = useId();
  const c = SELECTION_FIELD_TONES[tone];

  return (
    <div role="group" aria-labelledby={labelId} className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-1.5">
        <span id={labelId} className={`text-sm font-medium ${c.label}`}>
          {label}
        </span>
        {count !== undefined && <span className={`text-xs ${c.empty}`}>({count})</span>}
      </div>

      {chips.length === 0 ? (
        <p className={`text-xs ${c.empty}`}>{emptyLabel}</p>
      ) : (
        // Capped, and scrolling inside itself: dozens of chips would otherwise push
        // the form's own footer off a short viewport. The padding keeps a focused
        // remove button's outline from being clipped by the scroll box.
        <ul className="-m-0.5 flex max-h-24 flex-wrap gap-1.5 overflow-y-auto p-0.5" aria-label={label}>
          {chips.map((chip) => (
            <li
              key={chip.id}
              className={`inline-flex max-w-full items-center gap-1.5 rounded-full border py-0.5 pl-1 pr-0.5 text-xs ${c.chip}`}
            >
              {chip.leading}
              <span className="min-w-0 truncate pl-1">{chip.label}</span>
              <button
                type="button"
                onClick={() => onRemove(chip.id)}
                aria-label={removeLabel(chip)}
                title={removeLabel(chip)}
                className={`rounded-full p-1 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${c.chipRemove}`}
              >
                <X size={12} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      {hint && <p className={`text-xs ${c.empty}`}>{hint}</p>}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className={`flex w-fit items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${c.toggle}`}
      >
        {open ? <ChevronUp size={14} aria-hidden /> : <Plus size={14} aria-hidden />}
        {open ? doneLabel : addLabel}
      </button>

      <div id={panelId}>{open && children}</div>
    </div>
  );
}
