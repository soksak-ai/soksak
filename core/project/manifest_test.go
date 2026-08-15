package project

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"

	// Aliased: this package's own fake is named store.
	corestore "github.com/soksak/soksak-core/core/store"
)

// The real store is the one this ledger merges into, and every case in this
// file runs against a fake. Without this line the binding is checked nowhere
// until the launcher is written, and a signature that drifts in core/store
// fails there instead of here — a package that is green while the thing it was
// written for cannot be handed to it.
//
// Test-only, and it adds no dependency: core/control already pulls core/store
// in, so this edge exists whether or not it is spelled.
var _ ManifestStore = (*corestore.KV)(nil)

// store records what was written as well as what was read: "did not write" is
// half of what this file checks, and a value-only fake cannot show it.
type store struct {
	mu     sync.Mutex
	value  string
	found  bool
	sets   int
	gets   int
	lastNS string
	lastK  string
	failOn string
}

func (s *store) Get(ns, key string) (string, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.gets++
	s.lastNS, s.lastK = ns, key
	if s.failOn == "get" {
		return "", false, fmt.Errorf("the store is unreadable")
	}
	return s.value, s.found, nil
}

func (s *store) Set(ns, key, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sets++
	s.lastNS, s.lastK = ns, key
	s.value, s.found = value, true
	return nil
}

func (s *store) manifest(t *testing.T) map[string]any {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.found {
		t.Fatal("nothing was written")
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(s.value), &decoded); err != nil {
		t.Fatalf("the stored manifest is not an object: %v", err)
	}
	return decoded
}

func slotLabels(t *testing.T, manifest map[string]any) []string {
	t.Helper()
	slots, ok := manifest["slots"].([]any)
	if !ok {
		t.Fatalf("slots = %v, want an array", manifest["slots"])
	}
	labels := make([]string, 0, len(slots))
	for _, slot := range slots {
		labels = append(labels, slot.(map[string]any)["label"].(string))
	}
	return labels
}

func slot(label string, root string) map[string]any {
	return map[string]any{"label": label, "roots": []any{root}, "activeRoot": root}
}

// The merge happens inside the call. If the caller read the whole ledger and
// wrote it back, the second save would erase the first window's slot, and that
// loss surfaces as "I restarted and the other window did not come back".
func TestTwoWindowsBothSurviveOneLedger(t *testing.T) {
	backing := &store{}
	ledger := NewManifestLedger(backing)

	for _, entry := range []map[string]any{slot("w-1", "/a"), slot("w-2", "/b")} {
		changed, err := ledger.Upsert(entry, false)
		if err != nil {
			t.Fatalf("upserting %v: %v", entry, err)
		}
		if !changed {
			t.Fatalf("upserting %v reported no change", entry)
		}
	}

	if got, want := slotLabels(t, backing.manifest(t)), []string{"w-1", "w-2"}; strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("slots = %v, want %v", got, want)
	}
	// Spelled out rather than compared to the constants: comparing a constant
	// against itself passes whatever the constant says, and what it has to say
	// is the pair frontend/src/state/coreStore.ts and windowBoot.ts write
	// (ns "core", key "windows"). Drift there is not an error — the pruning
	// path deletes a key nobody wrote and the real ledger survives untouched.
	if backing.lastNS != "core" || backing.lastK != "windows" {
		t.Errorf("wrote %s/%s, want core/windows", backing.lastNS, backing.lastK)
	}
}

// An unchanged write reverts another window's concurrent update, so an
// unchanged slot must not reach the store at all.
func TestAnIdenticalSlotIsNotWritten(t *testing.T) {
	backing := &store{}
	ledger := NewManifestLedger(backing)

	if _, err := ledger.Upsert(slot("w-1", "/a"), false); err != nil {
		t.Fatalf("the first upsert: %v", err)
	}
	writes := backing.sets

	changed, err := ledger.Upsert(slot("w-1", "/a"), false)
	if err != nil {
		t.Fatalf("the second upsert: %v", err)
	}
	if changed {
		t.Error("an identical slot reported a change")
	}
	if backing.sets != writes {
		t.Errorf("sets = %d, want %d: an unchanged slot was written anyway", backing.sets, writes)
	}
}

// Identity is the decoded value, not the bytes. Key order differs between
// callers, and a byte comparison would write on every save — the exact thing
// the previous rule forbids.
func TestASlotWithItsKeysInAnotherOrderIsTheSameSlot(t *testing.T) {
	backing := &store{
		value: `{"slots":[{"roots":["/a"],"activeRoot":"/a","label":"w-1"}]}`,
		found: true,
	}
	// The premise: these bytes are not the bytes this entry encodes to. Without
	// that, the case would pass while comparing bytes and prove nothing.
	if encoded, _ := json.Marshal(slot("w-1", "/a")); strings.Contains(backing.value, string(encoded)) {
		t.Fatal("the stored spelling matches the encoded entry, so this case checks nothing")
	}
	ledger := NewManifestLedger(backing)

	changed, err := ledger.Upsert(slot("w-1", "/a"), false)
	if err != nil {
		t.Fatalf("upserting: %v", err)
	}
	if changed {
		t.Error("the same slot spelled in another key order reported a change")
	}
	if backing.sets != 0 {
		t.Error("the same slot spelled in another key order was written")
	}
}

// A window with no workspace has nothing to bring back. Measured
// 2026-07-28: after closing every window, one reload of the
// control window revived fifteen of them.
func TestAWindowWithNoRootsIsPruned(t *testing.T) {
	backing := &store{}
	ledger := NewManifestLedger(backing)

	if _, err := ledger.Upsert(slot("w-1", "/a"), false); err != nil {
		t.Fatalf("the first upsert: %v", err)
	}

	changed, err := ledger.Upsert(map[string]any{"label": "w-1", "roots": []any{}}, false)
	if err != nil {
		t.Fatalf("pruning: %v", err)
	}
	if !changed {
		t.Fatal("pruning a live slot reported no change")
	}
	if got := slotLabels(t, backing.manifest(t)); len(got) != 0 {
		t.Errorf("slots = %v, want none", got)
	}

	writes := backing.sets
	changed, err = ledger.Upsert(map[string]any{"label": "w-1", "roots": []any{}}, false)
	if err != nil {
		t.Fatalf("pruning again: %v", err)
	}
	if changed || backing.sets != writes {
		t.Error("pruning an absent slot reported a change")
	}
}

// A background save must not steal the focus record.
func TestFocusIsRecordedOnlyByTheFocusedWindow(t *testing.T) {
	backing := &store{}
	ledger := NewManifestLedger(backing)

	if _, err := ledger.Upsert(slot("w-1", "/a"), true); err != nil {
		t.Fatalf("the focused upsert: %v", err)
	}
	if got := backing.manifest(t)["focusedLabel"]; got != "w-1" {
		t.Errorf("focusedLabel = %v, want w-1", got)
	}

	writes := backing.sets
	changed, err := ledger.Upsert(slot("w-1", "/a"), true)
	if err != nil {
		t.Fatalf("the same focus again: %v", err)
	}
	if changed || backing.sets != writes {
		t.Error("the same focus reported a change")
	}

	if _, err := ledger.Upsert(slot("w-2", "/b"), false); err != nil {
		t.Fatalf("a background save: %v", err)
	}
	if got := backing.manifest(t)["focusedLabel"]; got != "w-1" {
		t.Errorf("focusedLabel = %v after a background save, want w-1 untouched", got)
	}
}

// The first save on a fresh home has no key to read.
func TestAMissingManifestIsAnEmptyOneNotAFailure(t *testing.T) {
	backing := &store{}
	changed, err := NewManifestLedger(backing).Upsert(slot("w-1", "/a"), false)
	if err != nil {
		t.Fatalf("the first save on a fresh home failed: %v", err)
	}
	if !changed {
		t.Error("the first save reported no change")
	}
	if got := slotLabels(t, backing.manifest(t)); len(got) != 1 {
		t.Errorf("slots = %v, want one", got)
	}
}

// Rewriting a shape we do not understand loses the whole restore state, which
// is not a price worth paying to record one window. Answering "unchanged"
// instead of failing would leave that window silently never restoring.
func TestAnUnknownManifestShapeIsRefusedAndLeftAlone(t *testing.T) {
	for _, odd := range []string{`{"slots":"nope"}`, `[]`, `"text"`, `null`} {
		backing := &store{value: odd, found: true}
		changed, err := NewManifestLedger(backing).Upsert(slot("w-1", "/a"), false)
		if err == nil {
			t.Errorf("%s was accepted, changed=%v", odd, changed)
			continue
		}
		if !strings.Contains(err.Error(), "slots") {
			t.Errorf("refusing %s did not name the shape: %v", odd, err)
		}
		if backing.sets != 0 || backing.value != odd {
			t.Errorf("%s was rewritten as %s", odd, backing.value)
		}
	}
}

// A slot with no label can never be matched again, so it can never be replaced
// or pruned.
func TestAnEntryWithoutALabelIsRefusedByName(t *testing.T) {
	for _, entry := range []map[string]any{
		{"roots": []any{"/a"}},
		{"label": 7, "roots": []any{"/a"}},
		{"label": "", "roots": []any{"/a"}},
	} {
		backing := &store{}
		_, err := NewManifestLedger(backing).Upsert(entry, false)
		if err == nil {
			t.Errorf("%v was accepted", entry)
			continue
		}
		if !strings.Contains(err.Error(), "label") {
			t.Errorf("refusing %v did not name what is missing: %v", entry, err)
		}
		if backing.sets != 0 {
			t.Errorf("%v was written anyway", entry)
		}
	}
}

// Two windows in one process save on the same debounce, so the overlap is
// ordinary rather than hypothetical.
func TestConcurrentUpsertsBothSurvive(t *testing.T) {
	backing := &store{}
	ledger := NewManifestLedger(backing)

	var start sync.WaitGroup
	var done sync.WaitGroup
	start.Add(1)
	for _, label := range []string{"w-1", "w-2"} {
		done.Add(1)
		go func(label string) {
			defer done.Done()
			start.Wait()
			if _, err := ledger.Upsert(slot(label, "/"+label), false); err != nil {
				panic(fmt.Sprintf("upserting %s: %v", label, err))
			}
		}(label)
	}
	start.Done()
	done.Wait()

	if got := slotLabels(t, backing.manifest(t)); len(got) != 2 {
		t.Errorf("slots = %v, want both windows", got)
	}
}

// An unreadable store is a failure, not an empty manifest: merging onto nothing
// would erase every other window's slot.
func TestAnUnreadableStoreIsAFailure(t *testing.T) {
	backing := &store{failOn: "get"}
	if _, err := NewManifestLedger(backing).Upsert(slot("w-1", "/a"), false); err == nil {
		t.Error("an unreadable store was treated as an empty manifest")
	}
	if backing.sets != 0 {
		t.Error("a manifest that could not be read was written anyway")
	}
}

// A ledger with no store to merge into is a wiring mistake, not a runtime
// condition: every save would answer "written" while nothing was written.
func TestAManifestLedgerWithoutAStoreRefusesToExist(t *testing.T) {
	defer func() {
		if recovered := recover(); recovered == nil {
			t.Error("a manifest ledger with no store was built; every save would be a silent success")
		}
	}()
	NewManifestLedger(nil)
}
