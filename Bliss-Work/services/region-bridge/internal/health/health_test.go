package health

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func readyz(t *testing.T, s *State) (int, string) {
	t.Helper()
	mux := http.NewServeMux()
	s.Handler(mux, http.NotFoundHandler())
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	return rec.Code, rec.Body.String()
}

func healthyExporter(stall time.Duration) *State {
	s := New(stall)
	s.SetNATS(true)
	s.SetKafkaFor("export:a", true)
	s.SetKafkaFor("export:b", true)
	s.SetEnabled(Export, true)
	return s
}

// B-RB-2: one healthy topic's Progress must not erase another topic's stall.
func TestExportStallOnOneTopicSurvivesAnotherTopicsProgress(t *testing.T) {
	s := healthyExporter(40 * time.Millisecond)

	s.FaultTopic(Export, "a", errors.New("jetstream down"))
	time.Sleep(80 * time.Millisecond) // topic a has now been failing past the budget
	s.ProgressTopic(Export, "b")      // topic b is healthy and busy

	if code, body := readyz(t, s); code != http.StatusServiceUnavailable {
		t.Fatalf("readyz = %d %q, want 503: topic a is stalled and b's progress must not hide it", code, body)
	}

	// Once a itself gets work through, the replica is ready again.
	s.ProgressTopic(Export, "a")
	if code, body := readyz(t, s); code != http.StatusOK {
		t.Fatalf("readyz = %d %q after the stalled topic recovered, want 200", code, body)
	}
}

// B-RB-2: Kafka is reachable only while NO reporter's latest result is a
// failure; a healthy topic's fetch must not flip it back.
func TestKafkaReachabilityIsPerReporter(t *testing.T) {
	s := healthyExporter(time.Minute)
	if !s.Snapshot().KafkaReachable {
		t.Fatal("want reachable while every reporter is ok")
	}
	s.SetKafkaFor("export:a", false)
	s.SetKafkaFor("export:b", true) // b's next fetch succeeds
	if s.Snapshot().KafkaReachable {
		t.Fatal("topic b's success flipped Kafka back to reachable while topic a is failing")
	}
	if code, _ := readyz(t, s); code != http.StatusServiceUnavailable {
		t.Fatalf("readyz = %d, want 503 while a topic cannot reach Kafka", code)
	}
	s.SetKafkaFor("export:a", true)
	if !s.Snapshot().KafkaReachable {
		t.Fatal("want reachable once every reporter is ok again")
	}
}

// A topic that blipped and then went idle is working, not stalled.
func TestClearedFaultDoesNotLookStalled(t *testing.T) {
	s := healthyExporter(40 * time.Millisecond)
	s.FaultTopic(Export, "a", errors.New("fetch blip"))
	s.ClearFaultTopic(Export, "a")
	time.Sleep(80 * time.Millisecond)
	if code, body := readyz(t, s); code != http.StatusOK {
		t.Fatalf("readyz = %d %q, want 200 for an idle healthy exporter", code, body)
	}
}

// The unchanged single-source behaviour: import stalls on pending work with no
// progress.
func TestImportStallStillDetected(t *testing.T) {
	s := New(40 * time.Millisecond)
	s.SetNATS(true)
	s.SetKafka(true)
	s.SetEnabled(Import, true)
	s.SetPending(5)
	time.Sleep(80 * time.Millisecond)
	if code, _ := readyz(t, s); code != http.StatusServiceUnavailable {
		t.Fatalf("readyz = %d, want 503 for backlog with no progress", code)
	}
	s.Progress(Import)
	if code, body := readyz(t, s); code != http.StatusOK {
		t.Fatalf("readyz = %d %q after progress, want 200", code, body)
	}
}

func TestSnapshotNamesFaultingTopics(t *testing.T) {
	s := healthyExporter(time.Minute)
	s.FaultTopic(Export, "task.events", errors.New("boom"))
	if got := s.Snapshot().LastError[Export]; got != "task.events: boom" {
		t.Fatalf("LastError = %q", got)
	}
}
