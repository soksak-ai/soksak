package service

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestWritingCreatesTheLedger(t *testing.T) {
	path := filepath.Join(t.TempDir(), "services", "ledger.json")

	changed, err := WriteLedger(path, json.RawMessage(`{"bindings":[]}`))
	if err != nil {
		t.Fatalf("writing: %v", err)
	}
	if !changed {
		t.Error("the first write must report a change")
	}

	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading back: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(contents, &decoded); err != nil {
		t.Fatalf("the ledger is not valid JSON: %v", err)
	}
}

func TestWritingTheSameContentChangesNothing(t *testing.T) {
	// Sync runs on every plugin state change and mostly writes what is already
	// there. Rewriting an identical file would churn the mtime, and anything
	// watching the ledger would wake for a change that did not happen.
	path := filepath.Join(t.TempDir(), "ledger.json")
	ledger := json.RawMessage(`{"bindings":[{"plugin":"a"}]}`)

	if _, err := WriteLedger(path, ledger); err != nil {
		t.Fatalf("first write: %v", err)
	}
	before, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}

	changed, err := WriteLedger(path, ledger)
	if err != nil {
		t.Fatalf("second write: %v", err)
	}
	if changed {
		t.Error("writing identical content must report no change")
	}

	after, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if !after.ModTime().Equal(before.ModTime()) {
		t.Error("the file was rewritten despite identical content")
	}
}

func TestADifferentLedgerReplacesTheOldOne(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.json")
	if _, err := WriteLedger(path, json.RawMessage(`{"bindings":[]}`)); err != nil {
		t.Fatalf("first write: %v", err)
	}

	changed, err := WriteLedger(path, json.RawMessage(`{"bindings":[{"plugin":"a"}]}`))
	if err != nil {
		t.Fatalf("second write: %v", err)
	}
	if !changed {
		t.Error("different content must report a change")
	}

	contents, _ := os.ReadFile(path)
	if !json.Valid(contents) {
		t.Fatal("the replacement is not valid JSON")
	}
	var decoded struct {
		Bindings []map[string]string `json:"bindings"`
	}
	_ = json.Unmarshal(contents, &decoded)
	if len(decoded.Bindings) != 1 {
		t.Errorf("ledger = %s", contents)
	}
}

func TestNoStagingFileSurvives(t *testing.T) {
	// The replacement is atomic: a reader either sees the old ledger or the new
	// one, never a half-written file. The staging file must not be left behind
	// to be mistaken for one.
	dir := t.TempDir()
	path := filepath.Join(dir, "ledger.json")
	if _, err := WriteLedger(path, json.RawMessage(`{"bindings":[]}`)); err != nil {
		t.Fatalf("writing: %v", err)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("listing: %v", err)
	}
	for _, entry := range entries {
		if entry.Name() != "ledger.json" {
			t.Errorf("left behind: %s", entry.Name())
		}
	}
}

func TestInvalidJSONIsRefused(t *testing.T) {
	// The ledger is read back by other processes. Writing something unparseable
	// would turn a bad input here into a failure somewhere else entirely.
	path := filepath.Join(t.TempDir(), "ledger.json")

	if _, err := WriteLedger(path, json.RawMessage(`{not json`)); err == nil {
		t.Fatal("an unparseable ledger must be refused")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Error("a refused ledger must not have been written")
	}
}
