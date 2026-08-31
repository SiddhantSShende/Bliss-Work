package store

// The call-lifecycle paths, against a real Postgres with RLS actually enforcing.
//
// ── Why these cannot be unit tests ───────────────────────────────────────────
// The bug this file exists to catch was invisible in Go. endCallTx ran to
// completion, returned no error from any statement, and simply wrote nothing:
// clearLobbyTx reset `app.bypass_rls` to 'off' halfway through, which is right
// under withCaller and a silent downgrade under withBypass, and every statement
// after it matched zero rows. In production that meant the call sweeper logged
// `call sweep failed … forbidden` every thirty seconds for as long as it had
// existed, and no call ever ended by itself.
//
// Only a database can show that. A losing bypass is not an error — it is rows
// that are not there — so the assertions have to be about rows.
//
// ── Why it must not run as a superuser ───────────────────────────────────────
// Every org table is ENABLE + FORCE ROW LEVEL SECURITY, and a superuser (or any
// BYPASSRLS role) skips policies entirely. Running these as `postgres` would
// pass with the bug still in place, which is worse than not running them. The
// URL must therefore name the least-privilege role the service itself uses; the
// check below refuses to run as anything that bypasses RLS.
//
// ── Running it ───────────────────────────────────────────────────────────────
// Opt-in, so `go test ./...` on a machine with no database still passes:
//
//	docker run -d --name lifecycle-pg -e POSTGRES_PASSWORD=pw -p 5599:5432 postgres:16
//	psql … -c "CREATE ROLE messaging_user LOGIN PASSWORD 'pw';
//	           GRANT ALL ON SCHEMA public TO messaging_user;
//	           ALTER SCHEMA public OWNER TO messaging_user;"
//	MESSAGING_TEST_DATABASE_URL='postgres://messaging_user:pw@127.0.0.1:5599/postgres' \
//	  go test ./internal/store/ -run TestCallLifecycle -v
//
// ── Why the schema is not built with Store.Migrate ───────────────────────────
// It cannot be, on an EMPTY database. Migrate runs every file in one
// transaction, and 0012_channel_roles.sql ends its backfill with a hard
// `set_config('app.bypass_rls', 'off')` — the same mistake this file's subject
// was — which leaves the bypass off for 0020_hide_chat_inbox_items.sql later in
// that same transaction, and 0020 refuses to run without it.
//
// Deployed databases never meet this: 0012 has long been in the ledger and does
// not re-run, so the bypass Migrate sets survives to 0020. A FIRST boot against
// an empty database does meet it, which is a real defect in its own right and
// out of this change's scope. So the schema here is applied file by file, each
// in its own transaction with the bypass freshly on — the same statements, in
// the same order, without the shared-transaction coupling.

import (
	"context"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/task-board/messaging-svc/internal/crypto"
	"github.com/task-board/messaging-svc/migrations"
)

// lifecycleStore opens the opt-in test database, migrates it, and refuses to
// proceed on a connection that would not have RLS applied to it.
func lifecycleStore(t *testing.T) *Store {
	t.Helper()
	url := os.Getenv("MESSAGING_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("MESSAGING_TEST_DATABASE_URL not set; see the header of this file")
	}
	ctx := context.Background()

	kek, err := crypto.NewDevKEKProvider("lifecycle-test-passphrase", []byte("0123456789abcdef"), 1)
	if err != nil {
		t.Fatalf("dev KEK: %v", err)
	}
	s, err := New(ctx, url, crypto.New(kek, time.Minute))
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(s.Close)

	// The guard. `rolsuper OR rolbypassrls` is exactly the set of roles for
	// which every policy in this file is a no-op.
	var privileged bool
	if err := s.pool.QueryRow(ctx, `
		SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user`).
		Scan(&privileged); err != nil {
		t.Fatalf("read current role: %v", err)
	}
	if privileged {
		t.Fatal("MESSAGING_TEST_DATABASE_URL connects as a SUPERUSER or BYPASSRLS role.\n\n" +
			"RLS is skipped entirely for those, so these tests would pass with the bug " +
			"they exist to catch still present. Point the URL at the least-privilege " +
			"role the service uses (messaging_user).")
	}

	migrateOnce(t, s)
	return s
}

// migrateOnce applies the embedded migrations, once per test binary.
//
// One transaction per file, each with the bypass set at its head — see the
// header for why Store.Migrate cannot do this against an empty database. No
// ledger: a scratch database is migrated once and thrown away, and every file
// is idempotent anyway.
var migrated bool

func migrateOnce(t *testing.T, s *Store) {
	t.Helper()
	if migrated {
		return
	}
	entries, err := migrations.FS.ReadDir(".")
	if err != nil {
		t.Fatalf("read migrations: %v", err)
	}
	names := []string{}
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".sql") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)

	ctx := context.Background()
	for _, name := range names {
		body, err := migrations.FS.ReadFile(name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		if err := s.withBypass(ctx, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, string(body))
			return err
		}); err != nil {
			t.Fatalf("apply %s: %v", name, err)
		}
	}
	migrated = true
}

// liveCall seeds one LIVE call with a host and a participant, both joined and
// neither having left — the shape every stale meeting in production had.
//
// Written under bypass because there is no caller here; this is the fixture,
// not the code under test.
type liveCall struct {
	id, orgID, host, guest string
}

func seedLiveCall(t *testing.T, s *Store, endsAt *time.Time) liveCall {
	t.Helper()
	c := liveCall{
		id:    uuid.Must(uuid.NewV7()).String(),
		orgID: uuid.Must(uuid.NewV7()).String(),
		host:  uuid.Must(uuid.NewV7()).String(),
		guest: uuid.Must(uuid.NewV7()).String(),
	}
	ctx := context.Background()
	err := s.withBypass(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO calls (id, org_id, kind, title, created_by, started_at, ends_at, status)
			VALUES ($1, $2, 'MEETING', 'lifecycle test', $3, now() - interval '2 hours', $4, 'LIVE')`,
			c.id, c.orgID, c.host, endsAt); err != nil {
			return err
		}
		for _, p := range []struct{ user, role string }{{c.host, RoleHost}, {c.guest, RoleParticipant}} {
			if _, err := tx.Exec(ctx, `
				INSERT INTO call_participants (call_id, user_id, org_id, role, joined_at)
				VALUES ($1, $2, $3, $4, now() - interval '2 hours')`,
				c.id, p.user, c.orgID, p.role); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("seed: %v", err)
	}
	t.Cleanup(func() {
		_ = s.withBypass(context.Background(), func(tx pgx.Tx) error {
			_, err := tx.Exec(context.Background(), `DELETE FROM calls WHERE id = $1`, c.id)
			return err
		})
	})
	return c
}

func callStatus(t *testing.T, s *Store, callID string) string {
	t.Helper()
	var status string
	ctx := context.Background()
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT status FROM calls WHERE id = $1`, callID).Scan(&status)
	}); err != nil {
		t.Fatalf("read status: %v", err)
	}
	return status
}

func openParticipants(t *testing.T, s *Store, callID string) int {
	t.Helper()
	var n int
	ctx := context.Background()
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT count(*) FROM call_participants
			WHERE call_id = $1 AND joined_at IS NOT NULL AND left_at IS NULL`, callID).Scan(&n)
	}); err != nil {
		t.Fatalf("count open participants: %v", err)
	}
	return n
}

func ago(d time.Duration) *time.Time {
	t := time.Now().UTC().Add(-d)
	return &t
}

func ahead(d time.Duration) *time.Time {
	t := time.Now().UTC().Add(d)
	return &t
}

// CASE D — the meetings that were already stuck.
//
// A LIVE call whose scheduled end passed hours ago, with every participant row
// still open. This is the production state precisely: four of these were LIVE
// for eighteen hours, and seven people were reported to their colleagues as
// being in them.
//
// It is also the regression test for the bypass bug, because ExpireOverdueCalls
// is where that bug surfaced. Before the fix this failed with ErrForbidden and
// the call was still LIVE afterwards.
func TestCallLifecycleOverdueSweepEndsAStaleCallAndFreesItsPeople(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	c := seedLiveCall(t, s, ago(time.Hour))

	busy, err := s.OnCallUserIDs(ctx, c.orgID)
	if err != nil {
		t.Fatalf("OnCallUserIDs: %v", err)
	}
	if len(busy) != 2 {
		t.Fatalf("before the sweep %d users are on call, want 2 (the fixture is wrong)", len(busy))
	}

	ended, err := s.ExpireOverdueCalls(ctx, OverdueSweepLimit)
	if err != nil {
		t.Fatalf("ExpireOverdueCalls: %v", err)
	}
	if !endedContains(ended, c.id) {
		t.Fatalf("the sweep did not report ending %s; it returned %d calls", c.id, len(ended))
	}

	if got := callStatus(t, s, c.id); got != CallEnded {
		t.Errorf("status = %q, want %q", got, CallEnded)
	}
	if n := openParticipants(t, s, c.id); n != 0 {
		t.Errorf("%d participant rows are still open, want 0 — these are what keep users Busy", n)
	}
	busy, err = s.OnCallUserIDs(ctx, c.orgID)
	if err != nil {
		t.Fatalf("OnCallUserIDs after: %v", err)
	}
	if len(busy) != 0 {
		t.Errorf("%v are still reported as on call after their meeting ended", busy)
	}

	// The DTO the caller fans out as call.ended must describe the call as it IS
	// now. An event whose body still said LIVE is what clients re-render as a
	// running meeting.
	for _, dto := range ended {
		if dto.ID == c.id && dto.Status != CallEnded {
			t.Errorf("the returned DTO says %q, want %q", dto.Status, CallEnded)
		}
	}
}

// Running the same sweep again must be quiet. Both replicas run their own
// ticker with no leader election, so this is the ordinary case, not an edge.
func TestCallLifecycleSweepingTwiceEndsNothingTheSecondTime(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	c := seedLiveCall(t, s, ago(time.Hour))

	if _, err := s.ExpireOverdueCalls(ctx, OverdueSweepLimit); err != nil {
		t.Fatalf("first sweep: %v", err)
	}
	again, err := s.ExpireOverdueCalls(ctx, OverdueSweepLimit)
	if err != nil {
		t.Fatalf("second sweep: %v", err)
	}
	if endedContains(again, c.id) {
		t.Error("the second sweep reported ending the same call again; the roster would be told twice")
	}
}

// CASE E — a meeting people are actually in must survive every rule here.
//
// The one that matters most: a repair that also closes live calls is worse than
// the bug it fixes.
func TestCallLifecycleLeavesAGenuinelyActiveCallAlone(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	c := seedLiveCall(t, s, ahead(time.Hour))

	if _, err := s.ExpireOverdueCalls(ctx, OverdueSweepLimit); err != nil {
		t.Fatalf("overdue sweep: %v", err)
	}
	if _, err := s.ExpireHostlessCalls(ctx, HostGracePeriod, OverdueSweepLimit); err != nil {
		t.Fatalf("hostless sweep: %v", err)
	}
	if got := callStatus(t, s, c.id); got != CallLive {
		t.Fatalf("an active meeting was ended by the sweeper: status = %q", got)
	}
	if n := openParticipants(t, s, c.id); n != 2 {
		t.Errorf("%d open participant rows, want 2 — the sweeper closed people out of a live call", n)
	}
}

// CASE B — the organiser's browser disappears.
//
// The SFU reports the departure, the participant row closes, and the call is
// still LIVE until the grace period has passed. Both halves are load-bearing:
// ending it on the webhook would take a meeting away from everyone in it
// because its organiser pressed F5.
func TestCallLifecycleUnannouncedHostDepartureEndsTheCallAfterTheGrace(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	c := seedLiveCall(t, s, nil) // no scheduled end: the sweeper's clock rule cannot save this one

	if _, err := s.MarkLeftFromSFU(ctx, c.id, c.host, ""); err != nil {
		t.Fatalf("MarkLeftFromSFU: %v", err)
	}
	if got := callStatus(t, s, c.id); got != CallLive {
		t.Fatalf("the call ended the instant the host's connection dropped: status = %q", got)
	}

	// Inside the grace period, nothing happens — a host who is reconnecting
	// still counts as present.
	ended, err := s.ExpireHostlessCalls(ctx, time.Hour, OverdueSweepLimit)
	if err != nil {
		t.Fatalf("hostless sweep inside the grace: %v", err)
	}
	if endedContains(ended, c.id) {
		t.Fatal("a host who dropped a moment ago was treated as gone")
	}

	// Past it, the call closes and everyone in it is freed.
	ended, err = s.ExpireHostlessCalls(ctx, time.Nanosecond, OverdueSweepLimit)
	if err != nil {
		t.Fatalf("hostless sweep past the grace: %v", err)
	}
	if !endedContains(ended, c.id) {
		t.Fatalf("a call with no host for longer than the grace was not ended")
	}
	if got := callStatus(t, s, c.id); got != CallEnded {
		t.Errorf("status = %q, want %q", got, CallEnded)
	}
	if n := openParticipants(t, s, c.id); n != 0 {
		t.Errorf("%d participant rows left open on an ended call", n)
	}
	busy, err := s.OnCallUserIDs(ctx, c.orgID)
	if err != nil {
		t.Fatalf("OnCallUserIDs: %v", err)
	}
	if len(busy) != 0 {
		t.Errorf("%v are still busy after the call ended", busy)
	}
}

// The SFU says the same thing twice — a retry, or a leave request that raced
// its own webhook. The second one must change nothing.
func TestCallLifecycleADuplicateDepartureIsHarmless(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	c := seedLiveCall(t, s, nil)

	if _, err := s.MarkLeftFromSFU(ctx, c.id, c.host, ""); err != nil {
		t.Fatalf("first departure: %v", err)
	}
	var first time.Time
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT left_at FROM call_participants WHERE call_id=$1 AND user_id=$2`,
			c.id, c.host).Scan(&first)
	}); err != nil {
		t.Fatalf("read left_at: %v", err)
	}

	if _, err := s.MarkLeftFromSFU(ctx, c.id, c.host, ""); err != nil {
		t.Fatalf("duplicate departure: %v", err)
	}
	var second time.Time
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT left_at FROM call_participants WHERE call_id=$1 AND user_id=$2`,
			c.id, c.host).Scan(&second)
	}); err != nil {
		t.Fatalf("re-read left_at: %v", err)
	}
	if !first.Equal(second) {
		t.Errorf("a duplicate webhook rewrote left_at (%s → %s); the grace period would restart every retry",
			first, second)
	}
}

// A webhook about a room this deployment has no call for, or a participant not
// on the roster. The SFU runs rooms we did not create; this is noise, not an
// error, and must never be reported as one.
func TestCallLifecycleAnUnknownRoomOrIdentityIsNotAnError(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	c := seedLiveCall(t, s, nil)
	stranger := uuid.Must(uuid.NewV7()).String()

	if _, err := s.MarkLeftFromSFU(ctx, uuid.Must(uuid.NewV7()).String(), stranger, ""); err != nil {
		t.Errorf("a departure from an unknown room: %v", err)
	}
	if _, err := s.MarkLeftFromSFU(ctx, c.id, stranger, ""); err != nil {
		t.Errorf("a departure by somebody not on the roster: %v", err)
	}
	if n := openParticipants(t, s, c.id); n != 2 {
		t.Errorf("an unrecognised departure closed %d real participant rows", 2-n)
	}
}

// CASE C — the organiser refreshed, and came back.
//
// MarkJoined puts left_at back to NULL, which is the whole of "reconnecting
// clears the condition": the hostless query stops matching and the call is
// never considered again.
func TestCallLifecycleAHostWhoReconnectsWithinTheGraceKeepsTheCallLive(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	c := seedLiveCall(t, s, nil)

	if _, err := s.MarkLeftFromSFU(ctx, c.id, c.host, ""); err != nil {
		t.Fatalf("MarkLeftFromSFU: %v", err)
	}
	if err := s.MarkJoined(ctx, c.orgID, c.host, c.id); err != nil {
		t.Fatalf("MarkJoined (the reconnect): %v", err)
	}

	// Even with the grace collapsed to nothing, a host who is BACK is present.
	ended, err := s.ExpireHostlessCalls(ctx, time.Nanosecond, OverdueSweepLimit)
	if err != nil {
		t.Fatalf("hostless sweep: %v", err)
	}
	if endedContains(ended, c.id) {
		t.Fatal("the call was ended under a host who had already reconnected")
	}
	if got := callStatus(t, s, c.id); got != CallLive {
		t.Fatalf("status = %q, want %q", got, CallLive)
	}
}

// CASE F — the SFU tore the room down because the last person left.
//
// The backstop for a call nobody was hosting. Ending one that is already over
// must report nothing rather than announce a second ending.
func TestCallLifecycleRoomFinishedEndsTheCallAndIsIdempotent(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	c := seedLiveCall(t, s, nil)

	ended, err := s.EndCallFromSFU(ctx, c.id)
	if err != nil {
		t.Fatalf("EndCallFromSFU: %v", err)
	}
	if ended == nil {
		t.Fatal("room_finished ended nothing on a LIVE call")
	}
	if ended.Status != CallEnded {
		t.Errorf("the returned DTO says %q, want %q", ended.Status, CallEnded)
	}
	if n := openParticipants(t, s, c.id); n != 0 {
		t.Errorf("%d participant rows left open", n)
	}

	again, err := s.EndCallFromSFU(ctx, c.id)
	if err != nil {
		t.Fatalf("second EndCallFromSFU: %v", err)
	}
	if again != nil {
		t.Error("ending an already-ended call reported an ending; call.ended would go out twice")
	}
}

// CASE A — the organiser pressed Leave. Unchanged by any of this, and checked
// here because it shares endCallTx with everything above: the bypass fix must
// not have altered the path that already worked.
func TestCallLifecycleAnExplicitHostLeaveStillEndsTheCallAtOnce(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	c := seedLiveCall(t, s, ahead(time.Hour))

	_, ended, err := s.LeaveCall(ctx, c.orgID, c.host, c.id)
	if err != nil {
		t.Fatalf("LeaveCall: %v", err)
	}
	if ended == nil {
		t.Fatal("the host leaving did not end the call")
	}
	if got := callStatus(t, s, c.id); got != CallEnded {
		t.Errorf("status = %q, want %q", got, CallEnded)
	}
	if n := openParticipants(t, s, c.id); n != 0 {
		t.Errorf("%d participant rows left open after the host left", n)
	}
	busy, err := s.OnCallUserIDs(ctx, c.orgID)
	if err != nil {
		t.Fatalf("OnCallUserIDs: %v", err)
	}
	if len(busy) != 0 {
		t.Errorf("%v are still busy after the host ended the call", busy)
	}
}

func endedContains(ended []*CallDTO, id string) bool {
	for _, c := range ended {
		if c != nil && c.ID == id {
			return true
		}
	}
	return false
}
