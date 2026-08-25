import { useState } from "react";

/** A `Set<string>` selection with the toggle/replace/clear operations every
 *  people-picker needs, so each stops reimplementing the same add-or-delete
 *  logic. Bulk "select all" stays caller-owned (`setAll`) since what "all"
 *  means differs per picker (visible candidates vs. the whole org). */
export function useToggleSet(initial: Iterable<string> = []) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initial));

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const setAll = (ids: Iterable<string>) => setSelected(new Set(ids));
  const clear = () => setSelected(new Set());

  return { selected, setSelected, toggle, setAll, clear } as const;
}
