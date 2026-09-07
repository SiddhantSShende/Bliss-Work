package store

// PlatformWhatsApp is the one ACTIVE external-forward destination today. It is
// the single literal both ForwardLinkRecord writes — into message_forwards.platform
// (provenance/audit) and messages/channel_messages.forward_platform (what the
// reader's client renders) — so the two columns can never name different
// providers for the same forward.
//
// slack/teams/gmail/outlook are NOT constants here on purpose: nothing in this
// service writes them. They exist only as values the schema CHECK constraints
// (0008, 0032) already allow, kept as headroom for a future integration that
// would need its own connected-account plumbing before it could ever be
// reached — see integrations-svc/app/routes/internal.py's orphaned
// /internal/messages/send for what that used to look like.
const PlatformWhatsApp = "whatsapp"
