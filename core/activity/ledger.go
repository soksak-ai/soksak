// Package activity is the record of what happened.
//
// Publishing is three separate things: admission stamps an entry, fan-out
// delivers it to windows, and persistence writes it down. Folding them together
// means a process with no window cannot even admit — and then the record has a
// hole exactly where the headless work happened.
package activity

import (
	"encoding/json"
	"sync"
)

// Retention scopes. The rule reads one entry and nothing else, so a process
// without storage can still answer it.
const (
	ScopeDefault = "default"
	ScopeLow     = "low"
)

// Entry is one admitted record.
type Entry struct {
	Seq             uint64          `json:"seq"`
	TimestampMillis uint64          `json:"ts"`
	Kind            string          `json:"kind"`
	Source          string          `json:"source"`
	Payload         json.RawMessage `json:"payload,omitempty"`
}

// Ledger issues sequence numbers.
type Ledger struct {
	mu  sync.Mutex
	seq uint64
}

func NewLedger() *Ledger { return &Ledger{} }

// Admit stamps the next entry. It neither delivers nor stores: those have
// their own owners, and a window-less process performs only this one.
func (ledger *Ledger) Admit(timestampMillis uint64, kind, source string, payload json.RawMessage) Entry {
	ledger.mu.Lock()
	ledger.seq++
	seq := ledger.seq
	ledger.mu.Unlock()

	return Entry{
		Seq:             seq,
		TimestampMillis: timestampMillis,
		Kind:            kind,
		Source:          source,
		Payload:         payload,
	}
}

// ResumeFrom continues after a restart, and only ever raises.
//
// The sequence is monotonic across restarts. Lowering it would reissue numbers
// already written, and two rows would then claim the same position.
func (ledger *Ledger) ResumeFrom(last uint64) {
	ledger.mu.Lock()
	defer ledger.mu.Unlock()
	if last > ledger.seq {
		ledger.seq = last
	}
}

// Len is what this ledger retains, which is nothing: retention belongs to
// whoever owns storage.
func (ledger *Ledger) Len() int { return 0 }

// RetentionScope says how long an entry is worth keeping.
//
// An entry relayed from elsewhere carries an origin and is low signal. An empty
// string is not an origin.
func RetentionScope(entry Entry) string {
	var payload struct {
		Origin string `json:"origin"`
	}
	if err := json.Unmarshal(entry.Payload, &payload); err != nil {
		return ScopeDefault
	}
	if payload.Origin != "" {
		return ScopeLow
	}
	return ScopeDefault
}
