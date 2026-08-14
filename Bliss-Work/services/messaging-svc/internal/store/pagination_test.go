package store

import "testing"

// clampMessagePage is the store-side ceiling. It exists separately from the
// HTTP layer's clamp because the store is reachable from more than one caller,
// and the invariant it protects — that a history read is always bounded — must
// not depend on which door the request came through.
func TestClampMessagePage(t *testing.T) {
	cases := []struct {
		in, want int
	}{
		{0, defaultMessagePage},
		{-1, defaultMessagePage},
		{-9999, defaultMessagePage},
		{1, 1},
		{50, 50},
		{maxMessagePage, maxMessagePage},
		{maxMessagePage + 1, maxMessagePage},
		{1 << 30, maxMessagePage},
	}
	for _, tc := range cases {
		if got := clampMessagePage(tc.in); got != tc.want {
			t.Errorf("clampMessagePage(%d) = %d, want %d", tc.in, got, tc.want)
		}
	}
}

// 0 means "from the newest", which the query expresses as a sentinel it can
// compare with a plain `seq < $n` rather than branching the SQL.
func TestBeforeSeqOrNewest(t *testing.T) {
	const sentinel = int64(1<<62 - 1)
	if got := beforeSeqOrNewest(0); got != sentinel {
		t.Errorf("beforeSeqOrNewest(0) = %d, want the newest sentinel %d", got, sentinel)
	}
	if got := beforeSeqOrNewest(-4); got != sentinel {
		t.Errorf("beforeSeqOrNewest(-4) = %d, want the newest sentinel %d", got, sentinel)
	}
	if got := beforeSeqOrNewest(1); got != 1 {
		t.Errorf("beforeSeqOrNewest(1) = %d, want 1", got)
	}
	if got := beforeSeqOrNewest(987654); got != 987654 {
		t.Errorf("beforeSeqOrNewest(987654) = %d, want 987654", got)
	}
	// A real seq must never be mistaken for the sentinel.
	if beforeSeqOrNewest(1) == sentinel {
		t.Error("seq 1 collided with the newest sentinel")
	}
}

// The history queries select DESC so the index can serve the LIMIT, but every
// caller and the wire format expect ascending order. If this reversal is wrong
// the whole thread renders backwards.
func TestReverseRaw(t *testing.T) {
	t.Run("odd length keeps the middle fixed", func(t *testing.T) {
		got := []int{3, 2, 1}
		reverseRaw(got)
		want := []int{1, 2, 3}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("got %v, want %v", got, want)
			}
		}
	})
	t.Run("even length", func(t *testing.T) {
		got := []string{"d", "c", "b", "a"}
		reverseRaw(got)
		want := []string{"a", "b", "c", "d"}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("got %v, want %v", got, want)
			}
		}
	})
	t.Run("empty and single are no-ops", func(t *testing.T) {
		var empty []int
		reverseRaw(empty) // must not panic on a nil slice
		one := []int{7}
		reverseRaw(one)
		if len(one) != 1 || one[0] != 7 {
			t.Fatalf("single-element slice was altered: %v", one)
		}
	})
	t.Run("reversing twice is the identity", func(t *testing.T) {
		got := []int{5, 4, 3, 2, 1}
		reverseRaw(got)
		reverseRaw(got)
		want := []int{5, 4, 3, 2, 1}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("got %v, want %v", got, want)
			}
		}
	})
}
