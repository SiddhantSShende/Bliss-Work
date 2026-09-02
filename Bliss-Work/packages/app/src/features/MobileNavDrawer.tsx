import { Rail } from "../routes/Rail";
import { Sheet } from "./Modal";

/**
 * The mobile hamburger's navigation drawer: the full labelled section list
 * (Mail…Settings), reusing `Rail`'s own `variant="drawer"` rendering — same
 * items, same active/badge logic, same routing calls the side rail and
 * bottom tab bar already use. Nothing about navigation is duplicated here;
 * this is only the slide-over chrome around it.
 *
 * Closes on: a nav item being selected (`Rail`'s `onSelect`), a tap outside
 * (Sheet's own backdrop), or the header close button (Sheet's `showClose`) —
 * all inherited from the shared `Sheet` primitive.
 */
export function MobileNavDrawer({
  open,
  onClose,
  section,
  badges,
}: {
  open: boolean;
  onClose: () => void;
  section: string | null;
  badges: Record<string, number>;
}) {
  return (
    <Sheet open={open} onClose={onClose} side="left" showClose title="BlissWork">
      <Rail variant="drawer" section={section} badges={badges} onSelect={onClose} className="-mx-5 w-auto" />
    </Sheet>
  );
}
