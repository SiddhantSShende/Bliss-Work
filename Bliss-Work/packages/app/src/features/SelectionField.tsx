import { useId, useState } from "react";
import { ChevronUp, Plus, X } from "lucide-react";

/** One selected thing, shown as a removable chip. */
export interface SelectionChip {
  id: string;
  label: string;
  /** An avatar or icon shown before the label. */
  leading?: React.ReactNode;
}

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
  hint,
  chips,
  onRemove,
  removeLabel,
  emptyLabel,
  addLabel,
  doneLabel,
  children,
}: {
  label: string;
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
}) {
  const [open, setOpen] = useState(false);
  const labelId = useId();
  const panelId = useId();

  return (
    <div role="group" aria-labelledby={labelId} className="flex flex-col gap-1.5">
      <span id={labelId} className="text-sm font-medium text-gray-700">
        {label}
      </span>

      {chips.length === 0 ? (
        <p className="text-xs text-gray-500">{emptyLabel}</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5" aria-label={label}>
          {chips.map((chip) => (
            <li
              key={chip.id}
              className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-gray-200 bg-gray-50 py-0.5 pl-1 pr-0.5 text-xs text-gray-800"
            >
              {chip.leading}
              <span className="min-w-0 truncate pl-1">{chip.label}</span>
              <button
                type="button"
                onClick={() => onRemove(chip.id)}
                aria-label={removeLabel(chip)}
                title={removeLabel(chip)}
                className="rounded-full p-1 text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              >
                <X size={12} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      {hint && <p className="text-xs text-gray-500">{hint}</p>}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-fit items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
      >
        {open ? <ChevronUp size={14} aria-hidden /> : <Plus size={14} aria-hidden />}
        {open ? doneLabel : addLabel}
      </button>

      <div id={panelId}>{open && children}</div>
    </div>
  );
}
