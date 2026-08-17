package config

import (
	"os"
	"testing"
)

// The broadcast consumer group has two requirements that pull in opposite
// directions, and the original code satisfied only one of them:
//
//	unique per node   — or Kafka splits the partitions between pods and a pod
//	                    stops receiving events for sockets it is holding
//	stable per node   — or every restart joins as a group with no committed
//	                    offset, starts at the tip, and skips everything
//	                    published while the pod was down
//
// It was "ws-gateway-"+uuid.NewString(), which is unique and maximally
// unstable. Because broadcast mode is the ONLY writer of the replay outbox,
// the events skipped that way were never written to any user's catch-up buffer
// either — a silent, unrecoverable hole in delivery on every deploy.

func TestBroadcastGroupIDPrefersTheExplicitSetting(t *testing.T) {
	t.Setenv("WS_BROADCAST_GROUP_ID", "ws-gateway-replica-3")
	if got := broadcastGroupID(); got != "ws-gateway-replica-3" {
		t.Errorf("broadcastGroupID() = %q, want the explicit value", got)
	}
}

func TestBroadcastGroupIDIsStableAcrossCalls(t *testing.T) {
	// The property the UUID version could not have. Two "process starts" in the
	// same environment must land in the same group, or the second resumes from
	// the tip and the gap between them is lost.
	t.Setenv("WS_BROADCAST_GROUP_ID", "")
	first := broadcastGroupID()
	second := broadcastGroupID()
	if first != second {
		t.Fatalf("group id is not stable: %q then %q — a restart would start a "+
			"fresh group at the tip and skip the events published while it was down",
			first, second)
	}
	if first == "" {
		t.Skip("hostname unreadable in this environment; Load's caller refuses to start")
	}
}

func TestBroadcastGroupIDDerivesFromHostname(t *testing.T) {
	t.Setenv("WS_BROADCAST_GROUP_ID", "")
	host, err := os.Hostname()
	if err != nil || host == "" {
		t.Skip("hostname unreadable in this environment")
	}
	want := "ws-gateway-" + host
	if got := broadcastGroupID(); got != want {
		t.Errorf("broadcastGroupID() = %q, want %q", got, want)
	}
}

func TestBroadcastGroupIDIsNotSharedBetweenPods(t *testing.T) {
	// The failure that would be WORSE than the bug being fixed: if every pod
	// resolved the same id they would form one consumer group, Kafka would give
	// each partition to exactly one of them, and a pod would silently stop
	// receiving events for users whose sockets it holds. The hostname default
	// is what prevents it, and main.go refuses to start when it is unavailable
	// rather than falling back to a constant.
	t.Setenv("WS_BROADCAST_GROUP_ID", "")
	id := broadcastGroupID()
	if id == "ws-gateway" || id == "ws-gateway-" {
		t.Fatalf("group id %q carries no per-pod identity", id)
	}
}

func TestLoadCarriesTheGroupID(t *testing.T) {
	t.Setenv("WS_BROADCAST_GROUP_ID", "ws-gateway-under-test")
	if got := Load().BroadcastGroupID; got != "ws-gateway-under-test" {
		t.Errorf("Load().BroadcastGroupID = %q, want the configured value", got)
	}
}
