import { Outlet, useLocation, useSearchParams, Link } from "react-router-dom";
import { ChevronLeft, MailOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { EmptyState } from "@taskboard/ui";
import { MailList } from "./MailList";
import { mailSearch, isMailDetailPath, folderOf, peerOf } from "../lib/mailView";

/**
 * Mail's second and third containers, side by side: the message list, and the
 * pane whatever you click on opens in.
 *
 * Everything under /app/mail renders through here. The message column is this
 * component's own child (it must survive being read from — opening a mail can
 * not throw away the list you picked it out of), and the pane beside it is the
 * <Outlet/>: the mail, the thread, the task or the composer. The first
 * container — the folders — is a level above, in the app shell.
 *
 * ── Which pane a window shows ────────────────────────────────────────────────
 * Below xl there is only room for one of them, so the list gives way to
 * whatever was opened and a back control brings it back. From xl up both are
 * on screen at once and the reading pane holds an empty state until something
 * is selected — the shape every mail client has.
 */
export function MailLayout() {
  const { t } = useTranslation("mail");
  const [params] = useSearchParams();
  const detailOpen = isMailDetailPath(useLocation().pathname);
  // The way back out of the reading pane returns to the list as it was left,
  // not to an unfiltered mailbox — see lib/mailView on why both filters live
  // in the search string.
  const backToList = { pathname: "/app/mail/all", search: mailSearch(folderOf(params), peerOf(params)) };

  return (
    <div className="flex h-full min-w-0 gap-2">
      <div
        className={
          detailOpen
            ? "glass hidden min-w-0 flex-col overflow-hidden rounded-2xl xl:flex xl:w-[21rem] xl:shrink-0 2xl:w-[24rem]"
            : "glass flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl xl:w-[21rem] xl:flex-none 2xl:w-[24rem]"
        }
      >
        <MailList />
      </div>

      <section
        className={`glass min-w-0 flex-col overflow-hidden rounded-2xl ${detailOpen ? "flex flex-1" : "hidden flex-1 xl:flex"}`}
      >
        {detailOpen && (
          // Narrow windows put the reading pane OVER the list, so it needs its
          // own way back. Hidden from xl up, where the list never left.
          <Link
            to={backToList}
            className="flex shrink-0 items-center gap-1 border-b border-border/60 px-3 py-2 text-xs font-medium text-muted transition-colors hover:text-fg xl:hidden"
          >
            <ChevronLeft size={15} /> {t("layout.backToList")}
          </Link>
        )}
        <div className="min-h-0 flex-1">
          <Outlet />
        </div>
      </section>
    </div>
  );
}

/**
 * The reading pane before anything is opened. Only ever visible from xl up,
 * where the list sits beside it rather than in its place.
 */
export function MailWelcome() {
  const { t } = useTranslation("mail");
  return (
    <div className="flex h-full items-center justify-center">
      <EmptyState
        icon={<MailOpen size={26} />}
        title={t("layout.welcome.title")}
        hint={t("layout.welcome.hint")}
      />
    </div>
  );
}
