// Package store holds what survives a restart.
//
// The SQL and the namespace rule live here rather than in a caller, because two
// processes writing their own queries drift, and a drifted query is not an
// error — it is a different answer.
package store

import (
	"database/sql"
	"fmt"
	"regexp"
	"time"

	"github.com/soksak-ai/soksak-core/core/i18n"
)

const (
	selectSQL = `SELECT v FROM kv WHERE ns=? AND k=?`
	upsertSQL = `INSERT INTO kv(ns,k,v,updated) VALUES(?,?,?,?)
		ON CONFLICT(ns,k) DO UPDATE SET v=excluded.v, updated=excluded.updated`
	deleteSQL = `DELETE FROM kv WHERE ns=? AND k=?`
)

// A namespace has no `/`, `.`, or `:`, so it cannot leak into a path or a
// meta key.
var namespacePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)

func validateNamespace(ns string) error {
	if !namespacePattern.MatchString(ns) {
		return i18n.Errorf("store.name.namespaceInvalid", map[string]string{"ns": ns})
	}
	return nil
}

// Get reads one value. A key that was never written is absence, not failure:
// the first read of every setting would otherwise be an error.
func (kv *KV) Get(ns, key string) (string, bool, error) {
	if err := validateNamespace(ns); err != nil {
		return "", false, err
	}
	var value string
	var found bool
	err := kv.read(func(db *sql.DB) error {
		switch err := db.QueryRow(selectSQL, ns, key).Scan(&value); err {
		case nil:
			found = true
			return nil
		case sql.ErrNoRows:
			return nil
		default:
			return fmt.Errorf("store: reading %s/%s: %w", ns, key, err)
		}
	})
	if err != nil {
		return "", false, err
	}
	return value, found, nil
}

// Set writes one value. The last write for a (namespace, key) is what remains.
//
// It reads the clock because its caller — the key-value command in the boot
// package — has no clock to hand it. Every caller inside this package that was
// given one uses setAt instead: a stamp taken here is one the caller cannot
// make the same twice.
func (kv *KV) Set(ns, key, value string) error {
	return kv.setAt(ns, key, value, time.Now().UnixMilli())
}

func (kv *KV) setAt(ns, key, value string, nowMillis int64) error {
	if err := validateNamespace(ns); err != nil {
		return err
	}
	return kv.read(func(db *sql.DB) error {
		if _, err := db.Exec(upsertSQL, ns, key, value, nowMillis); err != nil {
			return fmt.Errorf("store: writing %s/%s: %w", ns, key, err)
		}
		return nil
	})
}

// Delete removes one key. Deleting what is not there converges on the same
// state, so repeating it is safe.
func (kv *KV) Delete(ns, key string) error {
	if err := validateNamespace(ns); err != nil {
		return err
	}
	return kv.read(func(db *sql.DB) error {
		if _, err := db.Exec(deleteSQL, ns, key); err != nil {
			return fmt.Errorf("store: deleting %s/%s: %w", ns, key, err)
		}
		return nil
	})
}
