import { X } from "lucide-react";
import { useDialogBehavior } from "./Modal";

/**
 * The white card the meeting forms share (NewMeetingDialog, EditMeetingSeriesDialog).
 *
 * Deliberately hardcoded white/gray in every theme — see NewMeetingDialog's own doc
 * comment for why — with the accent as the one thing that follows the theme. It
 * The horizontal padding tightens below 400px. These forms are taller than the original
 * (repeat, members, channels), so on a short screen the card scrolls, and a classic
 * scrollbar takes ~10px of its width from fields that were already tight at 320px;
 * the smaller padding gives that back and then some.
 *
 * It owns what a dialog must do whatever it holds: close on Escape and on the
 * backdrop, trap and restore focus (useDialogBehavior), scroll rather than run off
 * a short window, and name itself for assistive technology.
 */
export function MeetingDialogShell({
  title,
  closeLabel,
  onClose,
  footer,
  wide,
  children,
}: {
  title: string;
  closeLabel: string;
  onClose: () => void;
  /** The button row, pinned below the body. Omit for a dialog with no actions. */
  footer?: React.ReactNode;
  /** Two-column forms: a wider card on screens that fit one. */
  wide?: boolean;
  children: React.ReactNode;
}) {
  const panelRef = useDialogBehavior(true, onClose);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={`flex max-h-[calc(100dvh-2rem)] w-full ${wide ? "max-w-4xl" : "max-w-md"} flex-col overflow-y-auto rounded-2xl border border-gray-200 bg-white px-4 py-6 shadow-lg min-[400px]:px-6`}
      >
        <div className="mb-5 flex shrink-0 items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            title={closeLabel}
            className="-mr-1 -mt-1 rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex flex-col gap-4">{children}</div>

        {footer && <div className="mt-6 flex shrink-0 items-center justify-end gap-2.5">{footer}</div>}
      </div>
    </div>
  );
}
