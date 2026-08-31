package store

// A meeting's transcript, against a real Postgres with RLS actually enforcing.
//
// See calls_lifecycle_db_test.go for the harness (opt-in via
// MESSAGING_TEST_DATABASE_URL, and why it must NOT run as a superuser).
//
// These cannot be unit tests. Three of the things this file asserts are facts
// about the database and nothing else:
//
//   - that a colleague in the hosting org who was never in the meeting can READ
//     its transcript but cannot WRITE to it, which is a policy, not a branch;
//   - that a cross-org guest's line is readable by the host and vice versa,
//     which turns on the transcript being sealed under the HOSTING org's DEK
//     rather than the writer's; and
//   - that what lands on disk is ciphertext.

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// endedMeeting is a finished cross-org meeting: a host in org A, a guest in
// org B, plus a colleague in org A who was never on the roster.
type endedMeeting struct {
	id, hostOrg, guestOrg, host, guest, colleague string
}

func seedEndedMeeting(t *testing.T, s *Store) endedMeeting {
	t.Helper()
	m := endedMeeting{
		id:        uuid.Must(uuid.NewV7()).String(),
		hostOrg:   uuid.Must(uuid.NewV7()).String(),
		guestOrg:  uuid.Must(uuid.NewV7()).String(),
		host:      uuid.Must(uuid.NewV7()).String(),
		guest:     uuid.Must(uuid.NewV7()).String(),
		colleague: uuid.Must(uuid.NewV7()).String(),
	}
	ctx := context.Background()
	err := s.withBypass(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO calls (id, org_id, kind, title, created_by,
			                   scheduled_at, started_at, ended_at, status)
			VALUES ($1, $2, 'MEETING', 'Sprint review', $3,
			        now() - interval '3 hours', now() - interval '3 hours',
			        now() - interval '2 hours', 'ENDED')`,
			m.id, m.hostOrg, m.host); err != nil {
			return err
		}
		for _, p := range []struct{ user, org, role string }{
			{m.host, m.hostOrg, RoleHost},
			{m.guest, m.guestOrg, RoleParticipant},
		} {
			if _, err := tx.Exec(ctx, `
				INSERT INTO call_participants (call_id, user_id, org_id, role, joined_at, left_at)
				VALUES ($1, $2, $3, $4, now() - interval '3 hours', now() - interval '2 hours')`,
				m.id, p.user, p.org, p.role); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("seed meeting: %v", err)
	}
	return m
}

// The round trip, and the thing that makes it worth having: a cross-org guest
// writes into the host's meeting, and BOTH sides read it back in plaintext.
func TestCallChatRoundTripsAcrossOrgs(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	m := seedEndedMeeting(t, s)

	if _, err := s.AppendCallChat(ctx, m.hostOrg, m.host, m.id, "", "Shall we ship it?", 0); err != nil {
		t.Fatalf("host chat: %v", err)
	}
	// The guest writes under their OWN org, into a meeting hosted by another.
	if _, err := s.AppendCallChat(ctx, m.guestOrg, m.guest, m.id, "", "Ship it.", 0); err != nil {
		t.Fatalf("guest chat: %v", err)
	}

	for _, who := range []struct {
		name, org, user string
	}{
		{"host", m.hostOrg, m.host},
		{"cross-org guest", m.guestOrg, m.guest},
	} {
		page, err := s.ListCallChat(ctx, who.org, who.user, m.id, "", 50)
		if err != nil {
			t.Fatalf("%s read: %v", who.name, err)
		}
		if len(page.Items) != 2 {
			t.Fatalf("%s read %d messages, want 2", who.name, len(page.Items))
		}
		// Oldest first — a transcript is read forwards.
		if page.Items[0].Text != "Shall we ship it?" || page.Items[1].Text != "Ship it." {
			t.Errorf("%s got %q then %q", who.name, page.Items[0].Text, page.Items[1].Text)
		}
		if page.NextCursor != nil {
			t.Errorf("%s: NextCursor set on a complete page", who.name)
		}
	}
}

// What lands on disk must not be the message.
func TestCallTranscriptIsEncryptedAtRest(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	m := seedEndedMeeting(t, s)

	const secret = "the number is 4815162342"
	if _, err := s.AppendCallChat(ctx, m.hostOrg, m.host, m.id, "", secret, 0); err != nil {
		t.Fatalf("chat: %v", err)
	}
	if _, err := s.AppendCallNote(ctx, m.hostOrg, m.host, m.id, "", secret, 0); err != nil {
		t.Fatalf("note: %v", err)
	}

	err := s.withBypass(ctx, func(tx pgx.Tx) error {
		for _, q := range []string{
			`SELECT body_enc FROM call_chat_messages WHERE call_id = $1`,
			`SELECT body_enc FROM call_notes WHERE call_id = $1`,
		} {
			var blob []byte
			if err := tx.QueryRow(ctx, q, m.id).Scan(&blob); err != nil {
				return err
			}
			if len(blob) == 0 {
				t.Errorf("%s: empty ciphertext", q)
			}
			if strings.Contains(string(blob), secret) {
				t.Errorf("%s: PLAINTEXT on disk", q)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("inspect: %v", err)
	}
}

// Who may read, and who may write, are DIFFERENT questions — and the gap
// between them is the point. An org colleague who was not in the meeting can
// read the record; nobody outside can; and only somebody who was actually
// there can add to it.
func TestCallTranscriptReadAndWriteAuthority(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	m := seedEndedMeeting(t, s)

	if _, err := s.AppendCallChat(ctx, m.hostOrg, m.host, m.id, "", "in the room", 0); err != nil {
		t.Fatalf("seed line: %v", err)
	}

	// 1. A colleague in the hosting org who never joined: may READ.
	page, err := s.ListCallChat(ctx, m.hostOrg, m.colleague, m.id, "", 50)
	if err != nil {
		t.Fatalf("colleague read: %v", err)
	}
	if len(page.Items) != 1 {
		t.Errorf("colleague read %d messages, want 1", len(page.Items))
	}

	// 2. ...but may NOT write. The record of a meeting cannot be edited after
	// the fact by somebody who was not in it.
	if _, err := s.AppendCallChat(ctx, m.hostOrg, m.colleague, m.id, "", "I was never here", 0); !errors.Is(err, ErrForbidden) {
		t.Errorf("colleague write: err = %v, want ErrForbidden", err)
	}

	// 3. A stranger in a third org: neither.
	outsiderOrg := uuid.Must(uuid.NewV7()).String()
	outsider := uuid.Must(uuid.NewV7()).String()
	if _, err := s.ListCallChat(ctx, outsiderOrg, outsider, m.id, "", 50); !errors.Is(err, ErrForbidden) {
		t.Errorf("outsider read: err = %v, want ErrForbidden", err)
	}
	if _, err := s.AppendCallChat(ctx, outsiderOrg, outsider, m.id, "", "hello", 0); !errors.Is(err, ErrForbidden) {
		t.Errorf("outsider write: err = %v, want ErrForbidden", err)
	}
}

// The same message arriving twice — a retry, a reconnect — is one line, not two.
//
// The key is the id the SENDER's client minted, which is a string it composes
// itself and NOT a uuid ("alice-1738…-x7q2"). That shape is exercised here on
// purpose: making it the primary key was the tempting shortcut, and the reason
// it is only an idempotency key is that a client must not choose the primary
// key of a shared table.
func TestCallChatIsIdempotentOnTheClientsOwnEntryID(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	m := seedEndedMeeting(t, s)
	const entry = "alice-1738000000000-x7q2"

	first, err := s.AppendCallChat(ctx, m.hostOrg, m.host, m.id, entry, "said once", 0)
	if err != nil {
		t.Fatalf("append: %v", err)
	}
	for i := 0; i < 3; i++ {
		again, aerr := s.AppendCallChat(ctx, m.hostOrg, m.host, m.id, entry, "said once", 0)
		if aerr != nil {
			t.Fatalf("retry %d: %v", i, aerr)
		}
		// A retry must answer with the SAME entry, or the sender ends up
		// holding two ids for one message.
		if again.ID != first.ID {
			t.Errorf("retry %d returned a new id %s, want %s", i, again.ID, first.ID)
		}
	}
	page, err := s.ListCallChat(ctx, m.hostOrg, m.host, m.id, "", 50)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("stored %d copies of one message, want 1", len(page.Items))
	}

	// Two people whose clients compose the SAME entry id are two messages.
	if _, err := s.AppendCallChat(ctx, m.guestOrg, m.guest, m.id, entry, "and so did I", 0); err != nil {
		t.Fatalf("guest same key: %v", err)
	}
	page, err = s.ListCallChat(ctx, m.hostOrg, m.host, m.id, "", 50)
	if err != nil {
		t.Fatalf("re-read: %v", err)
	}
	if len(page.Items) != 2 {
		t.Fatalf("a second sender's identical key collapsed into one row (%d rows)", len(page.Items))
	}
}

// Nothing worth no row gets one.
func TestCallTranscriptRefusesEmptyAndOversizedText(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	m := seedEndedMeeting(t, s)

	for _, tc := range []struct{ name, text string }{
		{"empty", ""},
		{"whitespace only", "   \n\t "},
		{"over the cap", strings.Repeat("x", CallTranscriptTextMax+1)},
	} {
		if _, err := s.AppendCallChat(ctx, m.hostOrg, m.host, m.id, "", tc.text, 0); !errors.Is(err, ErrForbidden) {
			t.Errorf("chat %s: err = %v, want ErrForbidden", tc.name, err)
		}
		if _, err := s.AppendCallNote(ctx, m.hostOrg, m.host, m.id, "", tc.text, 0); !errors.Is(err, ErrForbidden) {
			t.Errorf("note %s: err = %v, want ErrForbidden", tc.name, err)
		}
	}
}

// A transcript is paged forwards, and the boundary between pages must neither
// repeat a line nor lose one — including when several share a timestamp, which
// is what the id tie-break in the keyset is for.
func TestCallTranscriptPagesWithoutRepeatingOrSkipping(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	m := seedEndedMeeting(t, s)

	const total = 25
	// Every entry claims the SAME millisecond, so ordering can only come from
	// the id tie-break. A cursor keyed on time alone loops forever here.
	same := time.Now().UnixMilli()
	want := make([]string, 0, total)
	for i := 0; i < total; i++ {
		text := "line " + string(rune('a'+i))
		if _, err := s.AppendCallChat(ctx, m.hostOrg, m.host, m.id, "", text, same); err != nil {
			t.Fatalf("append %d: %v", i, err)
		}
		want = append(want, text)
	}

	var got []string
	cursor := ""
	for page := 0; ; page++ {
		if page > total {
			t.Fatal("cursor did not terminate")
		}
		p, err := s.ListCallChat(ctx, m.hostOrg, m.host, m.id, cursor, 7)
		if err != nil {
			t.Fatalf("page %d: %v", page, err)
		}
		for _, it := range p.Items {
			got = append(got, it.Text)
		}
		if p.NextCursor == nil {
			break
		}
		cursor = *p.NextCursor
	}
	if len(got) != total {
		t.Fatalf("paged %d entries, want %d (repeat or skip at a boundary)", len(got), total)
	}
	seen := map[string]bool{}
	for _, g := range got {
		if seen[g] {
			t.Errorf("entry %q returned twice", g)
		}
		seen[g] = true
	}
	for _, wantText := range want {
		if !seen[wantText] {
			t.Errorf("entry %q never returned", wantText)
		}
	}
}

// Notes carry their author, and read back in the order they were written.
func TestCallNotesRoundTrip(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	m := seedEndedMeeting(t, s)

	base := time.Now().Add(-time.Hour).UnixMilli()
	if _, err := s.AppendCallNote(ctx, m.hostOrg, m.host, m.id, "", "Decide on the rollout date", base); err != nil {
		t.Fatalf("host note: %v", err)
	}
	if _, err := s.AppendCallNote(ctx, m.guestOrg, m.guest, m.id, "", "Guest to send the contract", base+1000); err != nil {
		t.Fatalf("guest note: %v", err)
	}

	page, err := s.ListCallNotes(ctx, m.hostOrg, m.host, m.id, "", 50)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(page.Items) != 2 {
		t.Fatalf("read %d notes, want 2", len(page.Items))
	}
	if page.Items[0].AuthorID != m.host || page.Items[1].AuthorID != m.guest {
		t.Errorf("authors = %s, %s; want %s, %s",
			page.Items[0].AuthorID, page.Items[1].AuthorID, m.host, m.guest)
	}
	if page.Items[0].Text != "Decide on the rollout date" {
		t.Errorf("first note = %q", page.Items[0].Text)
	}
}

// The Past list. Every finished meeting must come back exactly once across the
// pages, no matter how many there are — that is the whole reason it has a
// cursor instead of a limit.
func TestCallHistoryPagesEveryMeetingExactlyOnce(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()

	orgID := uuid.Must(uuid.NewV7()).String()
	me := uuid.Must(uuid.NewV7()).String()
	const total = 23
	ids := map[string]bool{}

	err := s.withBypass(ctx, func(tx pgx.Tx) error {
		for i := 0; i < total; i++ {
			id := uuid.Must(uuid.NewV7()).String()
			ids[id] = false
			if _, err := tx.Exec(ctx, `
				INSERT INTO calls (id, org_id, kind, title, created_by,
				                   scheduled_at, started_at, ended_at, status)
				VALUES ($1, $2, 'MEETING', 'history', $3,
				        now() - make_interval(hours => $4),
				        now() - make_interval(hours => $4),
				        now() - make_interval(hours => $4) + interval '30 minutes', 'ENDED')`,
				id, orgID, me, i+1); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO call_participants (call_id, user_id, org_id, role, joined_at, left_at)
				VALUES ($1, $2, $3, 'HOST', now() - interval '1 hour', now())`,
				id, me, orgID); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("seed history: %v", err)
	}

	cursor := ""
	seen := 0
	for page := 0; ; page++ {
		if page > total {
			t.Fatal("cursor did not terminate")
		}
		p, perr := s.ListMyCallHistory(ctx, orgID, me, cursor, 5)
		if perr != nil {
			t.Fatalf("page %d: %v", page, perr)
		}
		for _, c := range p.Items {
			already, mine := ids[c.ID]
			if !mine {
				t.Fatalf("history returned a call that is not this user's: %s", c.ID)
			}
			if already {
				t.Errorf("call %s returned twice", c.ID)
			}
			ids[c.ID] = true
			seen++
			if c.Status != "ENDED" && c.Status != "CANCELLED" {
				t.Errorf("history returned a %s call", c.Status)
			}
		}
		if p.NextCursor == nil {
			break
		}
		cursor = *p.NextCursor
	}
	if seen != total {
		t.Fatalf("history paged %d meetings, want %d", seen, total)
	}
	for id, ok := range ids {
		if !ok {
			t.Errorf("meeting %s never appeared in the history", id)
		}
	}
}

// The history is the caller's OWN meetings. Somebody else's finished call, in
// the same org, must not appear in it just because it exists.
func TestCallHistoryIsScopedToTheCallersOwnRoster(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	m := seedEndedMeeting(t, s)

	// The colleague is in the hosting org and can READ that meeting's
	// transcript — but was never on its roster, so it is not in their history.
	page, err := s.ListMyCallHistory(ctx, m.hostOrg, m.colleague, "", 50)
	if err != nil {
		t.Fatalf("colleague history: %v", err)
	}
	for _, c := range page.Items {
		if c.ID == m.id {
			t.Fatal("a meeting the caller was never in appeared in their history")
		}
	}

	// The guest WAS on the roster, from another org entirely.
	page, err = s.ListMyCallHistory(ctx, m.guestOrg, m.guest, "", 50)
	if err != nil {
		t.Fatalf("guest history: %v", err)
	}
	found := false
	for _, c := range page.Items {
		if c.ID == m.id {
			found = true
		}
	}
	if !found {
		t.Error("a cross-org guest's own meeting is missing from their history")
	}
}
