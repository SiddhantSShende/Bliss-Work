package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/task-board/sticky-relay/internal/config"
	"github.com/task-board/sticky-relay/internal/sweep"
)

type fakeSource struct {
	pages [][]sweep.Pin
	calls int
}

func (f *fakeSource) Undelivered(context.Context, time.Duration, int) ([]sweep.Pin, error) {
	f.calls++
	if len(f.pages) == 0 {
		return nil, nil
	}
	p := f.pages[0]
	f.pages = f.pages[1:]
	return p, nil
}

type fakeSink struct {
	fail      bool
	published [][]sweep.Refresh
}

func (f *fakeSink) Publish(_ context.Context, r []sweep.Refresh, _ time.Time) error {
	if f.fail {
		return errors.New("kafka down")
	}
	f.published = append(f.published, r)
	return nil
}
func (f *fakeSink) DryRun() bool { return false }

func newTestRelay(src pinSource, sink refreshSink) *relay {
	return &relay{
		cfg:  &config.Config{StaleAfter: time.Minute, BatchLimit: 10},
		src:  src,
		sink: sink,
		log:  slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
}

func claimed(org, who string) sweep.Pin {
	return sweep.Pin{TaskID: "t-" + who, OrgID: org, AssigneeID: who, OpenedAt: time.Unix(0, 0), DeliveryAttempts: 1}
}

// B-SR-2: pins are claimed (an attempt spent) BEFORE the publish. A failed
// publish must not throw those nudges away — they go out once Kafka is back —
// and nothing more may be claimed while they are waiting.
func TestFailedPublishAfterClaimIsRetriedNotLost(t *testing.T) {
	src := &fakeSource{pages: [][]sweep.Pin{
		{claimed("o", "alice")},
		{claimed("o", "bob")},
	}}
	sink := &fakeSink{fail: true}
	r := newTestRelay(src, sink)

	r.runSweep(context.Background()) // claims alice, publish fails
	if len(sink.published) != 0 {
		t.Fatal("nothing should have been published while Kafka is down")
	}

	r.runSweep(context.Background()) // still down: must not claim bob's pin
	if src.calls != 1 {
		t.Fatalf("claimed %d times while the publish was failing, want 1 (no more attempts spent)", src.calls)
	}

	sink.fail = false
	r.runSweep(context.Background()) // recovered
	if len(sink.published) != 2 {
		t.Fatalf("published %d batches after recovery, want 2 (alice's retried, then bob's)", len(sink.published))
	}
	if first := sink.published[0]; len(first) != 1 || first[0].AssigneeID != "alice" {
		t.Fatalf("first published batch = %+v, want alice's pending nudge", first)
	}
	if second := sink.published[1]; len(second) != 1 || second[0].AssigneeID != "bob" {
		t.Fatalf("second published batch = %+v, want bob's", second)
	}
	if len(r.pending) != 0 {
		t.Fatalf("pending not cleared after success: %+v", r.pending)
	}
}

func TestSuccessfulPublishLeavesNothingPending(t *testing.T) {
	src := &fakeSource{pages: [][]sweep.Pin{{claimed("o", "alice")}}}
	sink := &fakeSink{}
	r := newTestRelay(src, sink)
	r.runSweep(context.Background())
	if len(sink.published) != 1 || len(r.pending) != 0 {
		t.Fatalf("published=%d pending=%d", len(sink.published), len(r.pending))
	}
}
