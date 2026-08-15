package store

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

// auto_vacuum is stamped into the file header when the store is born; setting
// it after the first CREATE is ignored and returns no error. Measured
// 2026-07-29: every home whose store was created from a bare
// connection was born auto_vacuum=NONE, and there the reclaim after a reap
// silently returns zero pages.
func TestTheStoreIsBornWithIncrementalAutoVacuum(t *testing.T) {
	kv := open(t)
	var mode int
	if err := kv.db.QueryRow("PRAGMA auto_vacuum").Scan(&mode); err != nil {
		t.Fatalf("reading auto_vacuum: %v", err)
	}
	if mode != 2 {
		t.Errorf("auto_vacuum = %d, want 2 (INCREMENTAL) — a reap would return no pages", mode)
	}
}

// Every table the storage commands read is created by opening, and creating is
// idempotent so reopening changes no shape.
func TestOpeningCreatesEveryTableTheCommandsRead(t *testing.T) {
	path := filepath.Join(t.TempDir(), "soksak.db")
	first, err := OpenKV(path)
	if err != nil {
		t.Fatalf("opening: %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("closing: %v", err)
	}
	second, err := OpenKV(path)
	if err != nil {
		t.Fatalf("reopening: %v", err)
	}
	t.Cleanup(func() { _ = second.Close() })

	for _, table := range []string{"kv", "records", "meta_collections"} {
		var name string
		err := second.db.QueryRow(
			`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, table).Scan(&name)
		if err != nil {
			t.Errorf("table %s: %v", table, err)
		}
	}
	for _, index := range []string{"records_scope", "records_created"} {
		var name string
		err := second.db.QueryRow(
			`SELECT name FROM sqlite_master WHERE type='index' AND name=?`, index).Scan(&name)
		if err != nil {
			t.Errorf("index %s: %v", index, err)
		}
	}
}

// One connection, not a pool. Exactly one write connection is held
// under a mutex on the 2026-08-01 measurement that a store held by value opened
// a new connection per call and then took `database is locked` from itself. An
// uncapped database/sql pool reproduces that inside one process.
func TestTheStoreHoldsOneConnection(t *testing.T) {
	if got := open(t).db.Stats().MaxOpenConnections; got != 1 {
		t.Errorf("MaxOpenConnections = %d, want 1", got)
	}
}

// The consequence of holding one connection: a read issued against the handle
// while a transaction is open waits for a connection that the transaction owns.
// Every read inside a transaction therefore goes through the *sql.Tx.
func TestAReadOutsideTheTransactionWaitsForIt(t *testing.T) {
	kv := open(t)
	tx, err := kv.db.Begin()
	if err != nil {
		t.Fatalf("beginning: %v", err)
	}
	defer func() { _ = tx.Rollback() }()

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	var one int
	err = kv.db.QueryRowContext(ctx, "SELECT 1").Scan(&one)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("a handle read inside a transaction answered %v (%v) — the single-connection rule has no teeth", one, err)
	}
}

// The write helper owns the transaction so no caller half-applies a batch, and
// it rolls back when the body refuses.
func TestAFailedWriteLeavesNothing(t *testing.T) {
	kv := open(t)
	sentinel := errors.New("refused")
	err := kv.write(func(tx *sql.Tx) error {
		if _, err := tx.Exec(upsertSQL, "ui", "theme", `"Midnight"`, 1); err != nil {
			return err
		}
		return sentinel
	})
	if !errors.Is(err, sentinel) {
		t.Fatalf("write returned %v, want the body's refusal", err)
	}
	if _, found, _ := kv.Get("ui", "theme"); found {
		t.Error("the rolled-back write survived")
	}
}

// A closed store answers by name. Returning an empty result with a nil error
// would make "this process holds no store" read as "there was nothing".
func TestAClosedStoreAnswersByName(t *testing.T) {
	kv, err := OpenKV(filepath.Join(t.TempDir(), "soksak.db"))
	if err != nil {
		t.Fatalf("opening: %v", err)
	}
	if err := kv.Close(); err != nil {
		t.Fatalf("closing: %v", err)
	}
	if _, _, err := kv.Get("ui", "theme"); err == nil {
		t.Error("a closed store answered a read without an error")
	}
}

// The store carries the path it was opened at: restore has to swap that file
// and reopen it, and a path recomputed on the other side is a second answer.
func TestTheStoreKnowsItsOwnPath(t *testing.T) {
	path := filepath.Join(t.TempDir(), "soksak.db")
	kv, err := OpenKV(path)
	if err != nil {
		t.Fatalf("opening: %v", err)
	}
	t.Cleanup(func() { _ = kv.Close() })
	if kv.Path() != path {
		t.Errorf("Path() = %q, want %q", kv.Path(), path)
	}
}
