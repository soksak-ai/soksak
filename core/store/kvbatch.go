package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/soksak-ai/soksak-core/core/i18n"
)

// Reading and clearing a namespace's keys in one pass.

// maxBatchKeys is what one delete batch may name.
//
// The list is itself an input resource, so the cap is at the store boundary
// rather than only at a catalogue: trusting catalogue validation lets an
// internal call skip the boundary entirely.
const maxBatchKeys = 4096

const (
	// The prefix is compared literally rather than as a LIKE pattern, so a key
	// holding `%` or `_` does not drag its neighbours in.
	selectKeysSQL = `SELECT k FROM kv WHERE ns=?
		AND (? IS NULL OR substr(k, 1, length(?))=?) ORDER BY k`
	selectEntriesSQL = `SELECT k, v FROM kv WHERE ns=?
		AND (? IS NULL OR substr(k, 1, length(?))=?) ORDER BY k`
)

// Entry is one key and the value stored under it.
type Entry struct {
	Key   string          `json:"key"`
	Value json.RawMessage `json:"value"`
}

// EntriesResult is a namespace's entries from one snapshot.
type EntriesResult struct {
	Ns      string  `json:"ns"`
	Entries []Entry `json:"entries"`
}

// DeleteManyResult reports what a batch requested and what it found.
type DeleteManyResult struct {
	Ns        string `json:"ns"`
	Requested int    `json:"requested"`
	Deleted   int    `json:"deleted"`
	Absent    int    `json:"absent"`
}

func prefixParameters(ns string, prefix *string) []any {
	if prefix == nil {
		return []any{ns, nil, nil, nil}
	}
	return []any{ns, *prefix, *prefix, *prefix}
}

// Keys lists a namespace's keys, sorted. A namespace nothing was ever written
// to is an empty list rather than a failure.
func (kv *KV) Keys(ns string, prefix *string) ([]string, error) {
	if err := validateNamespace(ns); err != nil {
		return nil, err
	}
	keys := []string{}
	err := kv.read(func(db *sql.DB) error {
		rows, err := db.Query(selectKeysSQL, prefixParameters(ns, prefix)...)
		if err != nil {
			return fmt.Errorf("store: listing the keys of %s: %w", ns, err)
		}
		defer func() { _ = rows.Close() }()
		for rows.Next() {
			var key string
			if err := rows.Scan(&key); err != nil {
				return fmt.Errorf("store: reading a key of %s: %w", ns, err)
			}
			keys = append(keys, key)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return keys, nil
}

// Entries reads a namespace's keys and values from one query.
//
// A keys-then-N-gets path is not offered: those N reads interleave with other
// writers, and the caller assembles a state that never existed.
//
// A stored value that is not JSON is an error naming where it is. Folding it
// into absence erases the difference from a missing key, and then the caller
// falls back to a default and never sees the damage.
func (kv *KV) Entries(ns string, prefix *string) (EntriesResult, error) {
	result := EntriesResult{Ns: ns, Entries: []Entry{}}
	if err := validateNamespace(ns); err != nil {
		return result, err
	}
	err := kv.read(func(db *sql.DB) error {
		rows, err := db.Query(selectEntriesSQL, prefixParameters(ns, prefix)...)
		if err != nil {
			return fmt.Errorf("store: reading the entries of %s: %w", ns, err)
		}
		defer func() { _ = rows.Close() }()
		for rows.Next() {
			var key, value string
			if err := rows.Scan(&key, &value); err != nil {
				return fmt.Errorf("store: reading an entry of %s: %w", ns, err)
			}
			if !json.Valid([]byte(value)) {
				return i18n.Errorf("store.entries.valueNotJSON", map[string]string{"ns": ns, "key": key})
			}
			result.Entries = append(result.Entries, Entry{Key: key, Value: json.RawMessage(value)})
		}
		return rows.Err()
	})
	return result, err
}

// DeleteKey removes one key and reports whether it was there. Both answers are
// ordinary: a delete converges on the same state either way.
func (kv *KV) DeleteKey(ns, key string) (bool, error) {
	if err := validateNamespace(ns); err != nil {
		return false, err
	}
	removed := false
	err := kv.read(func(db *sql.DB) error {
		result, err := db.Exec(deleteSQL, ns, key)
		if err != nil {
			return fmt.Errorf("store: deleting %s/%s: %w", ns, key, err)
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return fmt.Errorf("store: deleting %s/%s: %w", ns, key, err)
		}
		removed = affected > 0
		return nil
	})
	return removed, err
}

// DeleteMany removes exactly the keys named, in one transaction.
//
// There is no prefix delete. Every key is validated and de-duplicated before
// the transaction opens, so neither a bad input nor a failure partway can leave
// half a batch applied.
func (kv *KV) DeleteMany(ns string, keys []string) (DeleteManyResult, error) {
	result := DeleteManyResult{Ns: ns}
	if err := validateNamespace(ns); err != nil {
		return result, err
	}
	if len(keys) == 0 {
		return result, i18n.Errorf("store.deleteMany.noKeys", map[string]string{"ns": ns})
	}
	if len(keys) > maxBatchKeys {
		return result, i18n.Errorf("store.deleteMany.tooManyKeys", map[string]string{
			"count": strconv.Itoa(len(keys)),
			"max":   strconv.Itoa(maxBatchKeys),
		})
	}
	seen := make(map[string]struct{}, len(keys))
	unique := make([]string, 0, len(keys))
	for _, key := range keys {
		if key == "" {
			return result, i18n.Errorf("store.deleteMany.emptyKey", map[string]string{"ns": ns})
		}
		if _, already := seen[key]; already {
			continue
		}
		seen[key] = struct{}{}
		unique = append(unique, key)
	}
	result.Requested = len(unique)

	err := kv.write(func(tx *sql.Tx) error {
		for _, key := range unique {
			outcome, err := tx.Exec(deleteSQL, ns, key)
			if err != nil {
				return fmt.Errorf("store: deleting %s/%s: %w", ns, key, err)
			}
			affected, err := outcome.RowsAffected()
			if err != nil {
				return fmt.Errorf("store: deleting %s/%s: %w", ns, key, err)
			}
			if affected > 0 {
				result.Deleted++
			}
		}
		return nil
	})
	if err != nil {
		return DeleteManyResult{Ns: ns, Requested: len(unique)}, err
	}
	result.Absent = result.Requested - result.Deleted
	return result, nil
}
