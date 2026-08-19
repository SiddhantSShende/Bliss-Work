/**
 * The gateway's schema.
 *
 * Deliberately small. It covers READ COMPOSITION for the screens that were
 * paying for it, and nothing else: writes stay on REST (they carry idempotency
 * keys and optimistic cache patches wired into the WebSocket event stream),
 * realtime stays on the WebSocket gateway, and uploads/exports stay on the
 * endpoints that can stream them.
 *
 * Every field here resolves through a backing service's HTTP API. There is no
 * database client in this process, and adding one would make this a second
 * backend rather than a gateway — task titles, for instance, are encrypted and
 * only task-svc can read them.
 */
import { makeExecutableSchema } from "@graphql-tools/schema";
import { resolvers } from "./resolvers.js";

export const typeDefs = /* GraphQL */ `
  """
  A member of the caller's organisation.

  Only ever resolved for ids the caller can already see (a message sender, a
  task assignee, an inbox counterparty), and only within their own org.
  """
  type User {
    id: ID!
    orgId: ID!
    username: String!
    """
    Real name. NOT the same as \`username\`, which auth-svc derives from the
    e-mail local part at signup — rendering that where a name belongs is the
    bug this field exists to fix.
    """
    displayName: String!
    email: String!
    roles: [String!]!
    emailVerified: Boolean
    plan: String!
  }

  enum InboxItemKind {
    THREAD
    TASK
    MAIL
  }

  """One counterparty in the caller's inbox — a row in the People sidebar."""
  type InboxPeer {
    peerId: ID!
    """
    Projected by messaging-svc, and may lag a rename by a moment. Prefer
    \`user.displayName\`; these remain as the fallback for a peer whose account
    no longer resolves.
    """
    username: String
    displayName: String
    lastEventAt: String!
    unreadCount: Int!
    itemCount: Int!
    """
    The full account behind this peer, batched across every row of the query by
    a per-request DataLoader — one upstream call for the whole list, not one per
    row. Null when the id resolves to nobody in the caller's org.
    """
    user: User
  }

  type Query {
    """The signed-in user."""
    me: User!
    """
    Resolve specific people by id. Ids that do not belong to the caller's org
    are omitted rather than erroring, so the result may be shorter than the
    argument — match on \`id\`, never on position.
    """
    users(ids: [ID!]!): [User!]!
    """
    Distinct counterparties in the caller's inbox, newest activity first.
    Pass the same \`kinds\` as the feed beside it, or the badge counts rows the
    list does not show.
    """
    inboxPeers(kinds: [InboxItemKind!]): [InboxPeer!]!
  }
`;

export const schema = makeExecutableSchema({ typeDefs, resolvers });
