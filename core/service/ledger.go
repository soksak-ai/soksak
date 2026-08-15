// Package service keeps the bind ledger: which plugin is bound to which
// sidecar, written where other processes can read it.
package service

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// WriteLedger replaces the ledger and reports whether anything changed.
//
// Sync runs on every plugin state change and mostly writes what is already
// there, so identical content is left alone: rewriting would churn the mtime
// and wake anything watching for a change that did not happen.
//
// The replacement is atomic. A reader sees either the old ledger or the new
// one, never a half-written file, because a partial ledger would be read as a
// real one and would unbind services that are still running.
func WriteLedger(path string, ledger json.RawMessage) (bool, error) {
	if !json.Valid(ledger) {
		// Other processes read this file. Writing something unparseable turns a
		// bad input here into a failure somewhere else entirely.
		return false, fmt.Errorf("service: the ledger is not valid JSON")
	}

	var indented bytes.Buffer
	if err := json.Indent(&indented, ledger, "", "  "); err != nil {
		return false, fmt.Errorf("service: the ledger could not be formatted: %w", err)
	}
	next := indented.Bytes()

	if current, err := os.ReadFile(path); err == nil && bytes.Equal(current, next) {
		return false, nil
	}

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return false, fmt.Errorf("service: could not create %s: %w", dir, err)
	}

	staging := path + ".staging"
	if err := os.WriteFile(staging, next, 0o644); err != nil {
		return false, fmt.Errorf("service: could not stage the ledger: %w", err)
	}
	if err := os.Rename(staging, path); err != nil {
		_ = os.Remove(staging)
		return false, fmt.Errorf("service: could not replace the ledger: %w", err)
	}
	return true, nil
}
