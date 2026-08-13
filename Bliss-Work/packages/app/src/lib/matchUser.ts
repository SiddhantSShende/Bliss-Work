import type { UserDTO } from "@taskboard/shared";

/** Case-insensitive match across display name, username, and email. */
export function matchUser(u: UserDTO, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    u.displayName.toLowerCase().includes(q) ||
    u.username.toLowerCase().includes(q) ||
    u.email.toLowerCase().includes(q)
  );
}

/** Rank exact/prefix matches above substring matches for nicer ordering. */
export function rankUsers(users: UserDTO[], query: string): UserDTO[] {
  const q = query.trim().toLowerCase();
  if (!q) return users;
  const score = (u: UserDTO) => {
    const fields = [u.username, u.displayName, u.email].map((f) => f.toLowerCase());
    if (fields.some((f) => f === q)) return 0;
    if (fields.some((f) => f.startsWith(q))) return 1;
    return 2;
  };
  return [...users].sort((a, b) => score(a) - score(b));
}
