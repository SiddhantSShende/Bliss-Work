package store

// SendMessage, OpenConversation and Block must refuse a user who is not in the
// caller's org, against a real Postgres with RLS enforcing.
//
// ── Why this needs a database ────────────────────────────────────────────────
// All three upsert a `conversations` row stamped with the CALLER's org_id, so
// RLS has nothing to object to, and nothing else in the path looked at the other
// user. A user id learnt from another org (a cross-org meeting roster exposes
// them) therefore opened a conversation, and the message.created event was
// routed to that foreign user by id alone. Only rows show whether a refused call
// really wrote nothing.
//
// Opt-in on MESSAGING_TEST_DATABASE_URL; see calls_lifecycle_db_test.go's
// header for how to run it.

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// conversationsInOrg counts the conversations rows an org owns.
func conversationsInOrg(t *testing.T, s *Store, orgID string) int {
	t.Helper()
	ctx := context.Background()
	var n int
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT count(*) FROM conversations WHERE org_id = $1`, orgID).Scan(&n)
	}); err != nil {
		t.Fatalf("count conversations: %v", err)
	}
	return n
}

// crossOrgPair seeds a caller in one org and two candidate peers: one in the
// same org, one in another.
func crossOrgPair(t *testing.T, s *Store) (orgID, caller, colleague, outsider string) {
	t.Helper()
	orgID = uuid.Must(uuid.NewV7()).String()
	otherOrg := uuid.Must(uuid.NewV7()).String()
	caller = uuid.Must(uuid.NewV7()).String()
	colleague = uuid.Must(uuid.NewV7()).String()
	outsider = uuid.Must(uuid.NewV7()).String()
	seedUser(t, s, orgID, caller, "caller", "Caller")
	seedUser(t, s, orgID, colleague, "colleague", "Colleague")
	seedUser(t, s, otherOrg, outsider, "outsider", "Outsider")
	return orgID, caller, colleague, outsider
}

func TestSendMessage_RefusesARecipientFromAnotherOrgAndWritesNothing(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID, caller, _, outsider := crossOrgPair(t, s)

	_, err := s.SendMessage(ctx, orgID, caller, outsider, "hello stranger", uuid.Must(uuid.NewV7()).String(), SendOptions{})

	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("SendMessage to another org's user = %v, want ErrForbidden", err)
	}
	if n := conversationsInOrg(t, s, orgID); n != 0 {
		t.Fatalf("a refused send left %d conversation row(s) behind", n)
	}
}

func TestSendMessage_RefusesAnIdWithNoUserRow(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID, caller, _, _ := crossOrgPair(t, s)

	_, err := s.SendMessage(ctx, orgID, caller, uuid.Must(uuid.NewV7()).String(), "hi", uuid.Must(uuid.NewV7()).String(), SendOptions{})

	// Same answer as a foreign id, so a caller cannot tell "exists elsewhere" from "does not exist".
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("SendMessage to an unknown id = %v, want ErrForbidden", err)
	}
}

func TestSendMessage_StillDeliversToAColleague(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID, caller, colleague, _ := crossOrgPair(t, s)

	if _, err := s.SendMessage(ctx, orgID, caller, colleague, "hi", uuid.Must(uuid.NewV7()).String(), SendOptions{}); err != nil {
		t.Fatalf("SendMessage to a same-org user: %v", err)
	}
}

func TestOpenConversation_RefusesAPeerFromAnotherOrgAndWritesNothing(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID, caller, colleague, outsider := crossOrgPair(t, s)

	if _, err := s.OpenConversation(ctx, orgID, caller, outsider); !errors.Is(err, ErrForbidden) {
		t.Fatalf("OpenConversation with another org's user = %v, want ErrForbidden", err)
	}
	if n := conversationsInOrg(t, s, orgID); n != 0 {
		t.Fatalf("a refused open left %d conversation row(s) behind", n)
	}
	if _, err := s.OpenConversation(ctx, orgID, caller, colleague); err != nil {
		t.Fatalf("OpenConversation with a same-org user: %v", err)
	}
}

func TestBlock_RefusesAPeerFromAnotherOrgAndWritesNothing(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID, caller, colleague, outsider := crossOrgPair(t, s)

	if err := s.Block(ctx, orgID, caller, outsider); !errors.Is(err, ErrForbidden) {
		t.Fatalf("Block of another org's user = %v, want ErrForbidden", err)
	}
	if n := conversationsInOrg(t, s, orgID); n != 0 {
		t.Fatalf("a refused block left %d conversation row(s) behind", n)
	}
	if err := s.Block(ctx, orgID, caller, colleague); err != nil {
		t.Fatalf("Block of a same-org user: %v", err)
	}
}
