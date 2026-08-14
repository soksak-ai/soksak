package activity

import (
	"encoding/json"
	"testing"
)

func TestAdmitStampsAscendingSequence(t *testing.T) {
	ledger := NewLedger()

	first := ledger.Admit(1000, "boot", "core", nil)
	second := ledger.Admit(1001, "boot", "core", nil)

	if first.Seq != 1 || second.Seq != 2 {
		t.Errorf("sequences = %d, %d, want 1, 2", first.Seq, second.Seq)
	}
}

func TestAdmitNeitherFansOutNorPersists(t *testing.T) {
	// Admission is separate from delivery and from storage. Fold them together
	// and a process with no window cannot even admit — which is the whole
	// reason a headless core can keep a ledger at all.
	ledger := NewLedger()
	entry := ledger.Admit(1000, "boot", "core", nil)

	if entry.Seq == 0 {
		t.Fatal("admission must stamp the entry")
	}
	if ledger.Len() != 0 {
		t.Error("admission must not retain the entry; persistence is a separate owner")
	}
}

func TestResumeFromRaisesButNeverLowers(t *testing.T) {
	// The sequence is monotonic across restarts: it resumes from the persisted
	// maximum. A lower value would reissue numbers already written.
	ledger := NewLedger()
	ledger.ResumeFrom(41)

	if got := ledger.Admit(1000, "boot", "core", nil).Seq; got != 42 {
		t.Errorf("seq after resume = %d, want 42", got)
	}

	ledger.ResumeFrom(7)
	if got := ledger.Admit(1001, "boot", "core", nil).Seq; got != 43 {
		t.Errorf("a lower resume changed the sequence: %d", got)
	}
}

func TestEntriesCarryWhatTheCallerSent(t *testing.T) {
	ledger := NewLedger()
	payload := json.RawMessage(`{"reason":"started"}`)

	entry := ledger.Admit(1700000000000, "app.boot", "command", payload)

	if entry.Kind != "app.boot" || entry.Source != "command" {
		t.Errorf("entry = %+v", entry)
	}
	if entry.TimestampMillis != 1700000000000 {
		t.Errorf("timestamp = %d", entry.TimestampMillis)
	}
	if string(entry.Payload) != `{"reason":"started"}` {
		t.Errorf("payload = %s", entry.Payload)
	}
}

func TestAnOriginMarksAnEntryLowSignal(t *testing.T) {
	// Entries relayed from elsewhere carry an origin. The rule reads the entry
	// alone, so a process without storage can still answer it.
	relayed := Entry{Payload: json.RawMessage(`{"origin":"sok"}`)}
	direct := Entry{Payload: json.RawMessage(`{"reason":"started"}`)}
	blank := Entry{Payload: json.RawMessage(`{"origin":""}`)}

	if RetentionScope(relayed) != ScopeLow {
		t.Error("an entry with an origin is low signal")
	}
	if RetentionScope(direct) != ScopeDefault {
		t.Error("an entry without an origin is not low signal")
	}
	// An empty string is not an origin.
	if RetentionScope(blank) != ScopeDefault {
		t.Error("an empty origin must not mark an entry low signal")
	}
}

func TestAdmitIsSafeFromSeveralGoroutines(t *testing.T) {
	// Publishers are concurrent. Two entries sharing a sequence would make the
	// ledger's order unreadable after the fact.
	ledger := NewLedger()
	const publishers = 64
	done := make(chan uint64, publishers)

	for i := 0; i < publishers; i++ {
		go func() { done <- ledger.Admit(1000, "boot", "core", nil).Seq }()
	}

	seen := map[uint64]bool{}
	for i := 0; i < publishers; i++ {
		seq := <-done
		if seen[seq] {
			t.Fatalf("sequence %d was issued twice", seq)
		}
		seen[seq] = true
	}
}
