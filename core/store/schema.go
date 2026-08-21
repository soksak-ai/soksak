package store

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/soksak-ai/soksak-core/core/i18n"

	// A pure-Go driver, so Windows stays cgo-free and cross-compiles from any
	// host. The framework already depends on it.
	_ "modernc.org/sqlite"
)

// How the store is opened, and the shape it is opened onto.
//
// Two of these settings are stamped into the file when it is born and ignored
// afterwards, so the order below is a contract rather than a preference.

// openParameters is the DSN this process opens with.
//
// auto_vacuum is applied by the driver before the schema exists, which is the
// only moment it takes: a store born auto_vacuum=NONE answers every later
// `PRAGMA auto_vacuum=INCREMENTAL` with success and keeps NONE, and then
// data_retention_reap's page reclaim silently returns nothing. Measured
// 2026-07-29: every home whose store was first created from a
// bare connection was born that way, with no error anywhere.
//
// WAL lets a reader in another process run while this one writes, which is what
// makes "cannot write" and "cannot see" different states. busy_timeout is what
// makes that wait rather than fail.
//
// secure_delete zeroes freed cells instead of leaving them readable in the
// file. Unlike auto_vacuum it is a per-connection setting, not a property the
// file is born with — one reading called it born-once, and that half of the
// reasoning does not survive here. It is kept for what it does, at the cost of
// writing zeros over what a delete frees.
//
// txlock=immediate takes the write lock when a transaction opens rather than on
// its first write, so a transaction that will write cannot be told to retry
// halfway through, so every write transaction opens with BEGIN IMMEDIATE.
const openParameters = "?_auto_vacuum=INCREMENTAL" +
	"&_busy_timeout=5000" +
	"&_journal_mode=WAL" +
	"&_synchronous=NORMAL" +
	"&_foreign_keys=on" +
	"&_txlock=immediate" +
	"&_pragma=secure_delete(ON)" +
	"&_pragma=temp_store(MEMORY)"

// schemaSQL is every table and index the storage commands read.
//
// All of it is `IF NOT EXISTS`, so reopening changes no shape and whichever
// process opens first creates. The statements live here beside the rules that
// use them: two processes writing their own queries drift, and a drifted query
// is not an error — it is a different answer.
const schemaSQL = `
CREATE TABLE IF NOT EXISTS kv (
	ns TEXT NOT NULL,
	k TEXT NOT NULL,
	v TEXT NOT NULL,
	updated INTEGER NOT NULL,
	PRIMARY KEY (ns, k)
);
CREATE TABLE IF NOT EXISTS records (
	ns TEXT NOT NULL,
	coll TEXT NOT NULL,
	scope TEXT NOT NULL,
	id TEXT NOT NULL,
	doc TEXT NOT NULL,
	created INTEGER NOT NULL,
	updated INTEGER NOT NULL,
	PRIMARY KEY (ns, coll, id)
);
CREATE INDEX IF NOT EXISTS records_scope ON records(ns, coll, scope, updated);
CREATE INDEX IF NOT EXISTS records_created ON records(ns, coll, scope, created);
CREATE TABLE IF NOT EXISTS meta_collections (
	cid INTEGER PRIMARY KEY AUTOINCREMENT,
	ns TEXT NOT NULL,
	coll TEXT NOT NULL,
	idx_fields TEXT NOT NULL,
	fts_fields TEXT NOT NULL,
	UNIQUE (ns, coll)
);`

// KV is the store: the key-value table, the record collections, and the one
// connection they are all answered from.
type KV struct {
	// The handle is guarded rather than final because data_restore swaps the
	// file underneath it. Dropping the connection, swapping, and reopening must
	// be one hand — a process that swaps only the file goes on looking at what
	// is no longer there through its old connection.
	mu   sync.RWMutex
	db   *sql.DB
	path string
}

// OpenKV opens the store at path, creating the file and its schema if needed.
func OpenKV(path string) (*KV, error) {
	if path == "" {
		return nil, i18n.Errorf("store.open.noPath", nil)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("store: could not create %s: %w", filepath.Dir(path), err)
	}
	db, err := openDatabase(path)
	if err != nil {
		return nil, err
	}
	return &KV{db: db, path: path}, nil
}

func openDatabase(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", path+openParameters)
	if err != nil {
		return nil, fmt.Errorf("store: could not open %s: %w", path, err)
	}
	// One connection, not a pool. SQLite serialises writers rather than
	// refusing them, so a pool turns one writer into several that queue on each
	// other; a measurement caught a process taking `database is locked`
	// from its own connections (2026-08-01). The consequence every caller here
	// obeys: a read inside a transaction goes through that *sql.Tx, because the
	// connection it would otherwise want is the one the transaction holds.
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schemaSQL); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("store: could not create the schema: %w", err)
	}
	return db, nil
}

// Path is the file this store was opened at. Restore swaps that file and
// reopens it, and a path recomputed on the other side is a second answer.
func (kv *KV) Path() string {
	kv.mu.RLock()
	defer kv.mu.RUnlock()
	return kv.path
}

func (kv *KV) Close() error {
	kv.mu.Lock()
	defer kv.mu.Unlock()
	if kv.db == nil {
		return nil
	}
	db := kv.db
	kv.db = nil
	return db.Close()
}

// read runs fn against the open handle. A store with no handle answers by name:
// "this process holds no store" and "there was nothing" are different answers.
func (kv *KV) read(fn func(*sql.DB) error) error {
	kv.mu.RLock()
	defer kv.mu.RUnlock()
	if kv.db == nil {
		return i18n.Errorf("store.open.closed", map[string]string{"path": kv.path})
	}
	return fn(kv.db)
}

// write runs fn inside one transaction, and rolls back whatever fn refuses.
//
// The transaction is the unit a record and its index share. A measurement
// measured that separate autocommits for the record write and the FTS write
// left, after a crash between them, a record present with a stale index — and
// that shows up as wrong search results, not as an error.
func (kv *KV) write(fn func(*sql.Tx) error) error {
	return kv.read(func(db *sql.DB) error {
		tx, err := db.Begin()
		if err != nil {
			return fmt.Errorf("store: could not begin: %w", err)
		}
		if err := fn(tx); err != nil {
			_ = tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("store: could not commit: %w", err)
		}
		return nil
	})
}
