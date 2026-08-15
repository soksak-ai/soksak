package daemon

import (
	"fmt"
	"testing"
)

func TestTheRingKeepsTheLatestLinesAndDropsTheOldest(t *testing.T) {
	ring := newRing()
	for index := 0; index < ringCapacity+10; index++ {
		ring.keep(fmt.Sprintf("line %d", index))
	}

	held := ring.recent(ringCapacity)
	if len(held) != ringCapacity {
		t.Fatalf("the ring holds %d lines, want %d", len(held), ringCapacity)
	}
	if held[0] != fmt.Sprintf("line %d", 10) {
		t.Errorf("the oldest held line is %q; the ring dropped the wrong end", held[0])
	}
	if held[len(held)-1] != fmt.Sprintf("line %d", ringCapacity+9) {
		t.Errorf("the newest held line is %q", held[len(held)-1])
	}
}

func TestTheRingAnswersInArrivalOrder(t *testing.T) {
	ring := newRing()
	ring.keep("first")
	ring.keep("second")
	ring.keep("third")

	held := ring.recent(2)
	if len(held) != 2 || held[0] != "second" || held[1] != "third" {
		t.Fatalf("recent(2) = %q, want the last two in the order they arrived", held)
	}
}

// A daemon that has printed nothing answers with an empty list. Nil would
// arrive at the caller as JSON null, and "nothing has been printed" would read
// the same as "this build cannot tell you".
func TestASilentDaemonAnswersWithNoLinesRatherThanNull(t *testing.T) {
	held := newRing().recent(100)
	if held == nil {
		t.Fatal("recent answered nil; an empty log and an unanswerable one must not be the same value")
	}
	if len(held) != 0 {
		t.Fatalf("recent = %q, want empty", held)
	}
}

func TestAskingForMoreThanTheRingHoldsAnswersWithWhatIsThere(t *testing.T) {
	ring := newRing()
	ring.keep("only")

	if held := ring.recent(ringCapacity * 2); len(held) != 1 || held[0] != "only" {
		t.Fatalf("recent = %q, want the one line held", held)
	}
}
