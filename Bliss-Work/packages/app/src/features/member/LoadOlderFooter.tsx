import type { ReactNode } from "react";
import { Button } from "@taskboard/ui";

/**
 * The pagination footer under an infinite-scrolled list: a "Load older"
 * button while there's another page, otherwise whatever the panel wants to
 * say about why the list stops there (a retention note, or nothing at all).
 *
 * MemberAuditLog, MemberSessions and MemberTimeline each page a different
 * `useInfiniteQuery` over completely different rows, so only this bottom
 * scaffolding — not the query, the loading/empty states, or the row
 * rendering — is shared between them.
 */
export function LoadOlderFooter({
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  className = "pt-2 text-center",
  children,
}: {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  /** Wrapper classes around the button. MemberTimeline sits directly below a
   *  day heading and uses a tighter `pt-1` than the `pt-2` the other two
   *  panels use. */
  className?: string;
  /** Rendered once there is no next page, instead of the button — e.g. a note
   *  about the visibility window. Omit for a panel that simply has nothing
   *  left to show once paging runs out. */
  children?: ReactNode;
}) {
  if (hasNextPage) {
    return (
      <div className={className}>
        <Button variant="ghost" size="sm" loading={isFetchingNextPage} onClick={onLoadMore}>
          Load older
        </Button>
      </div>
    );
  }
  return children ?? null;
}
