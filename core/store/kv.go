// Package store holds what survives a restart.
//
// The SQL and the namespace rule live here rather than in a caller, because two
// processes writing their own queries drift, and a drifted query is not an
// error — it is a different answer.
package store

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"time"

	// A pure-Go driver, so Windows stays cgo-free and cross-compiles from any
	// host. The framework already depends on it.
	_ "modernc.org/sqlite"
)

const (
	schemaSQL = `CREATE TABLE IF NOT EXISTS kv (
		ns TEXT NOT NULL,
		k TEXT NOT NULL,
		v TEXT NOT NULL,
		updated INTEGER NOT NULL,
		PRIMARY KEY (ns, k)
	)`

	selectSQL = `SELECT v FROM kv WHERE ns=? AND k=?`
	upsertSQL = `INSERT INTO kv(ns,k,v,updated) VALUES(?,?,?,?)
		ON CONFLICT(ns,k) DO UPDATE SET v=excluded.v, updated=excluded.updated`
	deleteSQL = `DELETE FROM kv WHERE ns=? AND k=?`
)

// A namespace carries no `/`, `.`, or `:`, so it cannot leak into a path or a
// meta key.
var namespacePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)

func validateNamespace(ns string) error {
	if !namespacePattern.MatchString(ns) {
		return fmt.Errorf("store: namespace %q is not lowercase alphanumeric with hyphens", ns)
	}
	return nil
}

// KV is the key-value store, namespaced per owner.
type KV struct{ db *sql.DB }

// OpenKV opens the store at path, creating the file and its schema if needed.
func OpenKV(path string) (*KV, error) {
	if path == "" {
		return nil, fmt.Errorf("store: no database path was given")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("store: could not create %s: %w", filepath.Dir(path), err)
	}

	// WAL lets readers run while a writer holds the write lock, which is what
	// makes "cannot write" and "cannot see" different states.
	db, err := sql.Open("sqlite", path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, fmt.Errorf("store: could not open %s: %w", path, err)
	}
	if _, err := db.Exec(schemaSQL); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("store: could not create the schema: %w", err)
	}
	return &KV{db: db}, nil
}

func (kv *KV) Close() error { return kv.db.Close() }

// Get reads one value. A key that was never written is absence, not failure:
// the first read of every setting would otherwise be an error.
func (kv *KV) Get(ns, key string) (string, bool, error) {
	if err := validateNamespace(ns); err != nil {
		return "", false, err
	}
	var value string
	switch err := kv.db.QueryRow(selectSQL, ns, key).Scan(&value); err {
	case nil:
		return value, true, nil
	case sql.ErrNoRows:
		return "", false, nil
	default:
		return "", false, fmt.Errorf("store: reading %s/%s: %w", ns, key, err)
	}
}

// Set writes one value. The last write for a (namespace, key) is what remains.
func (kv *KV) Set(ns, key, value string) error {
	if err := validateNamespace(ns); err != nil {
		return err
	}
	if _, err := kv.db.Exec(upsertSQL, ns, key, value, time.Now().UnixMilli()); err != nil {
		return fmt.Errorf("store: writing %s/%s: %w", ns, key, err)
	}
	return nil
}

// Delete removes one key. Deleting what is not there converges on the same
// state, so repeating it is safe.
func (kv *KV) Delete(ns, key string) error {
	if err := validateNamespace(ns); err != nil {
		return err
	}
	if _, err := kv.db.Exec(deleteSQL, ns, key); err != nil {
		return fmt.Errorf("store: deleting %s/%s: %w", ns, key, err)
	}
	return nil
}
