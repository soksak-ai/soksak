package store

import (
	"database/sql"
	"fmt"
)

// Retention: how records leave when nobody deletes them.
//
// Two axes, one delete path. Trim is by count and reap is by time; they differ
// only in which rowids they select, and both remove whole records — a record
// present with its index gone is the shape this shares its transaction to
// prevent.

const (
	// FIFO by created, never by updated: an update moves updated, and evicting
	// by it makes the order nondeterministic between two runs with the same
	// data.
	trimRowidsSQL = `SELECT rowid FROM records WHERE ns=? AND coll=? AND scope=?
		ORDER BY created ASC, rowid ASC
		LIMIT MAX(0, (SELECT COUNT(*) FROM records WHERE ns=? AND coll=? AND scope=?) - ?)`

	// Scope-independent by design: the time axis reaps the collection. Which
	// scopes are still live is a judgement the caller holds, not the store.
	reapRowidsSQL = `SELECT rowid FROM records WHERE ns=? AND coll=? AND created < ?`
)

// Trim evicts the oldest records of one scope down to cap.
//
// A negative cap is refused rather than read as a number. The statement takes
// `count - cap` rows, so -1 means one more than the scope holds and the scope
// is emptied — a caller that meant "no limit" and sent -1 loses everything and
// gets told how many that was. Zero is a real answer and stays one: keep none.
func (kv *KV) Trim(ns, coll, scope string, cap int64) (int, error) {
	if err := validateNamespace(ns); err != nil {
		return 0, err
	}
	if err := validateCollection(coll); err != nil {
		return 0, err
	}
	if cap < 0 {
		return 0, fmt.Errorf("store: a trim of %s/%s asks to keep %d records", ns, coll, cap)
	}
	return kv.deleteSelected(ns, coll, trimRowidsSQL, []any{ns, coll, scope, ns, coll, scope, cap})
}

// Reap deletes records created before cutoffMillis, across every scope, then
// returns a bounded number of freed pages to the file.
//
// A logical delete does not shrink the file. Returning pages needs the store to
// have been born auto_vacuum=INCREMENTAL, and it is bounded rather than a full
// VACUUM because a full one takes a lock and rewrites everything.
func (kv *KV) Reap(ns, coll string, cutoffMillis int64) (int, error) {
	if err := validateNamespace(ns); err != nil {
		return 0, err
	}
	if err := validateCollection(coll); err != nil {
		return 0, err
	}
	deleted, err := kv.deleteSelected(ns, coll, reapRowidsSQL, []any{ns, coll, cutoffMillis})
	if err != nil {
		return 0, err
	}
	// Reclaim failing does not unmake the delete. The records are gone either
	// way, and reporting the delete as failed would invite a caller to repeat
	// it looking for a different answer.
	_ = kv.read(func(db *sql.DB) error {
		_, err := db.Exec(fmt.Sprintf("PRAGMA incremental_vacuum(%d)", reclaimedPagesBatch))
		return err
	})
	return deleted, nil
}

// deleteSelected reads the rowids to remove and removes them, all inside one
// transaction, so nothing observes a half-evicted record.
func (kv *KV) deleteSelected(ns, coll, statement string, params []any) (int, error) {
	deleted := 0
	err := kv.write(func(tx *sql.Tx) error {
		rows, err := tx.Query(statement, params...)
		if err != nil {
			return fmt.Errorf("store: selecting records of %s/%s to remove: %w", ns, coll, err)
		}
		var rowids []int64
		for rows.Next() {
			var rowid int64
			if err := rows.Scan(&rowid); err != nil {
				_ = rows.Close()
				return fmt.Errorf("store: reading a record to remove: %w", err)
			}
			rowids = append(rowids, rowid)
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return fmt.Errorf("store: selecting records of %s/%s to remove: %w", ns, coll, err)
		}
		if err := rows.Close(); err != nil {
			return fmt.Errorf("store: selecting records of %s/%s to remove: %w", ns, coll, err)
		}
		meta, err := collectionMeta(tx, ns, coll)
		if err != nil {
			return err
		}
		if err := deleteRows(tx, meta, rowids); err != nil {
			return err
		}
		deleted = len(rowids)
		return nil
	})
	return deleted, err
}
