package store

// A reassigned task must come back as work in the assignee's unified inbox.
//
// task-svc reopens a COMPLETED task by emitting task.assigned again for the same
// (assignee, task). InsertTaskInboxItem is idempotent by design — it keeps the first
// row — so without a deliberate exception the row stays at COMPLETED and the person
// the task was handed back to sees finished work. The exception must not also let a
// REDELIVERED original assignment undo a completion, which is why the test pins both.
//
// Opt-in on MESSAGING_TEST_DATABASE_URL; see calls_lifecycle_db_test.go's header.

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func taskBadge(t *testing.T, s *Store, ownerID, taskID string) (badge string, unread int) {
	t.Helper()
	ctx := context.Background()
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT status_badge, unread_count FROM inbox_items
			WHERE owner_user_id = $1 AND item_kind = 'TASK' AND ref_id = $2`,
			ownerID, taskID).Scan(&badge, &unread)
	}); err != nil {
		t.Fatalf("read task inbox row: %v", err)
	}
	return badge, unread
}

func TestInsertTaskInboxItem_ReassignmentReopensACompletedRow(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	org := uuid.Must(uuid.NewV7()).String()
	sender := uuid.Must(uuid.NewV7()).String()
	owner := uuid.Must(uuid.NewV7()).String()
	task := uuid.Must(uuid.NewV7()).String()
	t0 := time.Now().UTC().Truncate(time.Microsecond)

	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(s.InsertTaskInboxItem(ctx, org, owner, task, sender, "Review report", "", t0))
	must(s.UpdateTaskStatusBadge(ctx, owner, task, "ACKNOWLEDGED", t0.Add(time.Minute)))
	must(s.UpdateTaskStatusBadge(ctx, owner, task, "COMPLETED", t0.Add(2*time.Minute)))
	must(s.MarkInboxItemRead(ctx, org, owner, "TASK", task))
	if badge, unread := taskBadge(t, s, owner, task); badge != "COMPLETED" || unread != 0 {
		t.Fatalf("setup: badge=%q unread=%d, want COMPLETED/0", badge, unread)
	}

	// A redelivery of the ORIGINAL assignment (older than the completion): no change.
	must(s.InsertTaskInboxItem(ctx, org, owner, task, sender, "Review report", "", t0))
	if badge, unread := taskBadge(t, s, owner, task); badge != "COMPLETED" || unread != 0 {
		t.Fatalf("redelivered assignment: badge=%q unread=%d, want COMPLETED/0 (a replay must not undo a completion)", badge, unread)
	}

	// The reassignment: newer than the completion.
	must(s.InsertTaskInboxItem(ctx, org, owner, task, sender, "Review report", "", t0.Add(time.Hour)))
	if badge, unread := taskBadge(t, s, owner, task); badge != "SENT" || unread != 1 {
		t.Fatalf("reassigned: badge=%q unread=%d, want SENT/1", badge, unread)
	}

	// And the lifecycle continues from there as it always does.
	must(s.UpdateTaskStatusBadge(ctx, owner, task, "ACKNOWLEDGED", t0.Add(2*time.Hour)))
	must(s.InsertTaskInboxItem(ctx, org, owner, task, sender, "Review report", "", t0.Add(3*time.Hour)))
	if badge, _ := taskBadge(t, s, owner, task); badge != "ACKNOWLEDGED" {
		t.Fatalf("a task.assigned for an open task changed its badge to %q; only COMPLETED rows reopen", badge)
	}
}
