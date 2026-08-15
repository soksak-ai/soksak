package project

import (
	"encoding/json"
	"fmt"
	"reflect"
	"sync"
)

const (
	// ManifestNamespace and ManifestKey are where the restore ledger is stored.
	//
	// They have to be the pair the application itself writes. If they drift,
	// the pruning path deletes a key nobody wrote and the real ledger survives
	// — silently, with no error.
	ManifestNamespace = "core"
	ManifestKey       = "windows"
)

// ManifestStore is the slice of the key-value store this package needs.
// *store.KV satisfies it.
type ManifestStore interface {
	Get(ns, key string) (string, bool, error)
	Set(ns, key, value string) error
}

// ManifestLedger reads, merges, and writes one window's restore slot.
//
// All three happen here rather than in the caller. A caller that reads the
// whole ledger and writes it back loses the other window's slot whenever the
// two overlap — two windows in one process share a save debounce, so the
// overlap is ordinary. The loss is not an error: it is "I restarted and the
// other window did not come back".
type ManifestLedger struct {
	// mu serializes read-merge-write for this store.
	//
	// It closes the race between windows in this process, which is the one that
	// exists here. It does not close a race between processes: KV.Get and
	// KV.Set are separate statements, and only a store-side update running both
	// in one transaction would close that. Two processes sharing one home would
	// need it; this build has one.
	mu    sync.Mutex
	store ManifestStore
}

func NewManifestLedger(store ManifestStore) *ManifestLedger {
	if store == nil {
		panic("project: NewManifestLedger needs a store to merge into")
	}
	return &ManifestLedger{store: store}
}

// Upsert merges entry into the ledger and answers whether anything changed.
//
// An unchanged ledger is not rewritten: that write would revert another
// window's concurrent update.
func (ledger *ManifestLedger) Upsert(entry map[string]any, focused bool) (bool, error) {
	label, err := labelOf(entry)
	if err != nil {
		return false, err
	}

	ledger.mu.Lock()
	defer ledger.mu.Unlock()

	manifest, err := ledger.read()
	if err != nil {
		return false, err
	}

	changed, err := UpsertSlot(manifest, entry)
	if err != nil {
		return false, err
	}
	if focused && SetFocused(manifest, label) {
		// A window that is not focused leaves the record alone, so a background
		// save cannot steal it.
		changed = true
	}
	if !changed {
		return false, nil
	}

	encoded, err := json.Marshal(manifest)
	if err != nil {
		return false, fmt.Errorf("the merged window manifest could not be encoded: %w", err)
	}
	if err := ledger.store.Set(ManifestNamespace, ManifestKey, string(encoded)); err != nil {
		return false, err
	}
	return true, nil
}

// read answers with the stored ledger, or an empty one.
//
// A key that was never written is an empty manifest — the first save on a fresh
// home has nothing to read. A store that cannot be read is a failure: merging
// onto an assumed-empty ledger would erase every other window's slot.
func (ledger *ManifestLedger) read() (map[string]any, error) {
	raw, found, err := ledger.store.Get(ManifestNamespace, ManifestKey)
	if err != nil {
		return nil, err
	}
	if !found {
		return map[string]any{"slots": []any{}}, nil
	}

	var decoded any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return nil, fmt.Errorf("the window manifest is not JSON, so its slots cannot be merged: %w", err)
	}
	manifest, isObject := decoded.(map[string]any)
	if !isObject {
		return nil, fmt.Errorf("the window manifest is %T, so its slots cannot be merged", decoded)
	}
	if _, present := manifest["slots"]; !present {
		// Absence is a shape to establish, not a refusal: the first merge needs
		// somewhere to put the slot.
		manifest["slots"] = []any{}
	}
	return manifest, nil
}

// UpsertSlot puts one window's slot into a decoded manifest, replacing the slot
// with the same label. It answers whether the manifest changed.
//
// Both arguments are values as encoding/json produces them — lists are []any,
// numbers are float64. A Go-native []string would compare unequal to the
// decoded slot it is meant to match, and the slot would be rewritten on every
// save, which is the write these rules exist to prevent.
//
// Empty roots is a removal: a window with no workspace has nothing to bring
// back, and a slot left behind respawns a window the user closed.
func UpsertSlot(manifest map[string]any, entry map[string]any) (bool, error) {
	label, err := labelOf(entry)
	if err != nil {
		return false, err
	}

	roots, hasRoots := entry["roots"].([]any)
	if !hasRoots || len(roots) == 0 {
		return PruneSlot(manifest, label)
	}

	slots, err := slotsOf(manifest)
	if err != nil {
		return false, err
	}
	for index, existing := range slots {
		if labelIn(existing) != label {
			continue
		}
		// Compared as decoded values rather than bytes. Key order differs
		// between callers, and a byte comparison would report a change on every
		// save — which is the write this rule exists to prevent.
		if reflect.DeepEqual(existing, any(entry)) {
			return false, nil
		}
		slots[index] = entry
		manifest["slots"] = slots
		return true, nil
	}
	manifest["slots"] = append(slots, entry)
	return true, nil
}

// PruneSlot removes one window's slot. It answers whether anything was removed,
// because removing nothing must not trigger a write.
func PruneSlot(manifest map[string]any, label string) (bool, error) {
	slots, err := slotsOf(manifest)
	if err != nil {
		return false, err
	}
	kept := make([]any, 0, len(slots))
	for _, slot := range slots {
		if labelIn(slot) != label {
			kept = append(kept, slot)
		}
	}
	if len(kept) == len(slots) {
		return false, nil
	}
	manifest["slots"] = kept
	return true, nil
}

// SetFocused records the window the user last looked at, and answers whether
// that record changed.
func SetFocused(manifest map[string]any, label string) bool {
	if existing, ok := manifest["focusedLabel"].(string); ok && existing == label {
		return false
	}
	manifest["focusedLabel"] = label
	return true
}

// slotsOf refuses a manifest whose slots are not a list.
//
// Rewriting a shape we do not understand loses the whole restore state, and
// that is not a price worth paying to record one window. It fails rather than
// answering "unchanged": unchanged reads as success, and then that window
// silently never restores.
func slotsOf(manifest map[string]any) ([]any, error) {
	slots, isList := manifest["slots"].([]any)
	if !isList {
		return nil, fmt.Errorf("the window manifest has slots of type %T, not a list, and is left untouched", manifest["slots"])
	}
	return slots, nil
}

func labelOf(entry map[string]any) (string, error) {
	label, isText := entry["label"].(string)
	if !isText || label == "" {
		// A slot with no label can never be matched again, so it can never be
		// replaced or pruned.
		return "", fmt.Errorf("a window manifest entry needs a label, and this one has %v", entry["label"])
	}
	return label, nil
}

func labelIn(slot any) string {
	object, isObject := slot.(map[string]any)
	if !isObject {
		return ""
	}
	label, _ := object["label"].(string)
	return label
}
