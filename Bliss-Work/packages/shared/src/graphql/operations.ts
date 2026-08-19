/**
 * The gateway's trusted documents — every GraphQL operation the product is
 * allowed to execute, in one place that both sides of the wire import.
 *
 * ── Why a shared module and not a build-time hash manifest ──────────────────
 * The usual persisted-query setup hashes the client's document text and ships a
 * manifest the server loads, because the client's copy is the source of truth
 * and the server has to verify what it was sent. Here there is only ONE copy:
 * the gateway and the app both import this file out of the same workspace, so a
 * document cannot differ between them and there is nothing for a hash to prove.
 * The operation NAME is therefore a sufficient id — and unlike a hash it stays
 * readable in a URL, an access log and a CDN cache key.
 *
 * The security property is unchanged and is the one that matters: the gateway
 * executes what is in this registry and refuses everything else, so no client
 * can compose a document the schema allows but the product never intended.
 *
 * ── Adding an operation ─────────────────────────────────────────────────────
 * Add it here, then call it via `api.graphql("<Name>", variables, schema)`.
 * Nothing else needs regenerating; there is no manifest to forget.
 */

export const GRAPHQL_OPERATIONS = {
  /**
   * The Inbox pilot. Replaces two REST calls — `/api/v1/inbox/peers` plus a
   * `/auth/directory` fetch of the ENTIRE organisation whose only purpose was
   * putting a name and an address on the rows actually on screen.
   */
  InboxOverview: `
    query InboxOverview($kinds: [InboxItemKind!]) {
      inboxPeers(kinds: $kinds) {
        peerId
        username
        displayName
        lastEventAt
        unreadCount
        itemCount
        user {
          id
          displayName
          email
        }
      }
    }
  `,

  /**
   * Resolve specific people by id.
   *
   * The surfaces that need this — a meeting roster, an incoming call — know
   * exactly whose names they are about to draw, and there are rarely more than
   * a dozen. Before the gateway the only way to ask was `GET /auth/directory`,
   * which returns up to 5,000 members, so opening a roster of four downloaded
   * the entire organisation.
   *
   * Ids that do not resolve are OMITTED, so the result may be shorter than the
   * argument. Callers must match on `id`, never on position.
   */
  UsersByIds: `
    query UsersByIds($ids: [ID!]!) {
      users(ids: $ids) {
        id
        username
        displayName
        email
      }
    }
  `,
} as const;

export type GraphqlOperationName = keyof typeof GRAPHQL_OPERATIONS;

export function isGraphqlOperationName(name: string): name is GraphqlOperationName {
  return Object.prototype.hasOwnProperty.call(GRAPHQL_OPERATIONS, name);
}
