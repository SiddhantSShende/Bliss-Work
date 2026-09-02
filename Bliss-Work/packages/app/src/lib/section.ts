/**
 * Route → section. One mapping, three consumers.
 *
 * The shell already derived "which section am I in" twice — once for the list
 * pane, once to highlight the rail — and telemetry needs the same answer a third
 * time. Three copies of a prefix chain is three chances for a new route to be
 * classified inconsistently, which for telemetry would silently mis-attribute
 * time to the wrong part of the product.
 */

/** Sections that own a contextual list pane in the shell. */
export type ListSection = "mail" | "chats" | "channels" | "members" | "tasks";

/** Every part of the product a user can be "in", for time attribution. */
export type Surface =
  | ListSection
  | "search"
  | "invite"
  | "profile"
  | "settings"
  | "meetings"
  | "org";

/** Meetings is deliberately NOT here. It is a rail entry that renders
 *  full-width: its calendar needs the whole main pane, and the Upcoming / Live
 *  / Past column it used to put in the shell is now the tab strip under that
 *  calendar. railSectionOf below still highlights it. */
const LIST_SECTIONS: ListSection[] = ["mail", "tasks", "channels", "members", "chats"];
const UTILITY: Surface[] = [
  "search",
  "invite",
  "profile",
  "settings",
  "meetings",
  "org",
];

/**
 * The list-pane section, or null for a full-width utility page.
 *
 * Prefix-matched on `/app/<name>` rather than exact-matched so a detail route
 * (`/app/chats/:id`) stays in its section.
 */
export function listSectionOf(pathname: string): ListSection | null {
  return LIST_SECTIONS.find((s) => pathname.startsWith(`/app/${s}`)) ?? null;
}

/**
 * The rail item to highlight. Meetings and Org are rail entries but render
 * full-width, so they highlight without opening a list pane.
 */
export function railSectionOf(pathname: string): string | null {
  if (pathname.startsWith("/app/settings")) return "settings";
  if (pathname.startsWith("/app/meetings")) return "meetings";
  if (pathname.startsWith("/app/org")) return "org";
  return listSectionOf(pathname);
}

/** The telemetry surface — every section, including the utility pages. */
export function surfaceOf(pathname: string): Surface | null {
  return listSectionOf(pathname) ?? UTILITY.find((s) => pathname.startsWith(`/app/${s}`)) ?? null;
}
