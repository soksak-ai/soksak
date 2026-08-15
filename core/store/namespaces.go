package store

import (
	"database/sql"
	"fmt"
)

// Whole-namespace operations: taking one back, and moving one.

// NsRemoval is what removing a namespace took.
type NsRemoval struct {
	Ns          string `json:"ns"`
	Collections int    `json:"collections"`
	Records     int    `json:"records"`
	KV          int    `json:"kv"`
}

// MigrateOutcome reports whether a namespace moved, and why not when it did not.
type MigrateOutcome struct {
	Migrated bool   `json:"migrated"`
	Reason   string `json:"reason"`
}

// RemoveNamespace removes everything one namespace made: its records, its keys,
// its collection definitions, its search tables and its expression indexes.
//
// The name is not validated here. A measurement found a namespace that an
// unvalidated import planted — `plugin:probe-lane` — which the delete surface
// then refused as an invalid name: something that got in and could not get out.
// Deletion only removes what exists, so the syntax rule protects nothing here.
// It is safe because nothing on this path builds SQL from the name: it is a
// bound parameter everywhere, and the only interpolated identifiers come from
// the integer collection id and from field names a rule already vetted.
//
// A namespace with nothing in it is zeros rather than a failure, so calling
// this twice converges.
func (kv *KV) RemoveNamespace(ns string) (NsRemoval, error) {
	removal := NsRemoval{Ns: ns}
	err := kv.write(func(tx *sql.Tx) error {
		cids, err := collectionIdentifiers(tx, ns)
		if err != nil {
			return err
		}
		records, err := affected(tx.Exec(`DELETE FROM records WHERE ns=?`, ns))
		if err != nil {
			return fmt.Errorf("store: removing the records of %s: %w", ns, err)
		}
		keys, err := affected(tx.Exec(`DELETE FROM kv WHERE ns=?`, ns))
		if err != nil {
			return fmt.Errorf("store: removing the keys of %s: %w", ns, err)
		}
		for _, cid := range cids {
			// The search table is that collection's alone, so it goes
			// whole. The expression indexes sit on records, which every
			// namespace shares, so they are found by name and dropped: one left
			// behind keeps making another namespace's writes heavy.
			if _, err := tx.Exec("DROP TABLE IF EXISTS " + quoteIdentifier(ftsTable(cid))); err != nil {
				return fmt.Errorf("store: removing the search table of collection %d: %w", cid, err)
			}
			if err := dropUndeclaredIndexes(tx, cid, nil); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(`DELETE FROM meta_collections WHERE ns=?`, ns); err != nil {
			return fmt.Errorf("store: removing the definitions of %s: %w", ns, err)
		}
		removal.Collections = len(cids)
		removal.Records = records
		removal.KV = keys
		return nil
	})
	if err != nil {
		return NsRemoval{Ns: ns}, err
	}
	return removal, nil
}

func collectionIdentifiers(q querier, ns string) ([]int64, error) {
	rows, err := q.Query(`SELECT cid FROM meta_collections WHERE ns=?`, ns)
	if err != nil {
		return nil, fmt.Errorf("store: reading the collections of %s: %w", ns, err)
	}
	defer func() { _ = rows.Close() }()
	var cids []int64
	for rows.Next() {
		var cid int64
		if err := rows.Scan(&cid); err != nil {
			return nil, fmt.Errorf("store: reading a collection of %s: %w", ns, err)
		}
		cids = append(cids, cid)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: reading the collections of %s: %w", ns, err)
	}
	return cids, nil
}

func affected(result sql.Result, err error) (int, error) {
	if err != nil {
		return 0, err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return 0, err
	}
	return int(count), nil
}

// MigrateNamespace re-points one namespace's rows onto another name.
//
// A namespace is a plugin id, so renaming a plugin makes its old keys and
// records invisible under the new name — not lost, but unreachable, which is
// the same thing to whoever is looking. Both names are validated because this
// path creates a namespace, and a path that creates what the rules forbid means
// the rules are not rules.
//
// The search tables and expression indexes need no move: they key off the
// collection id, and the expression indexes sit on records, whose ns this
// updates.
//
// Data on both sides is an error. A safe merge is impossible, and a silent loss
// is not an option.
func (kv *KV) MigrateNamespace(from, to string) (MigrateOutcome, error) {
	if err := validateNamespace(from); err != nil {
		return MigrateOutcome{}, err
	}
	if err := validateNamespace(to); err != nil {
		return MigrateOutcome{}, err
	}
	if from == to {
		return MigrateOutcome{Migrated: false, Reason: "same-ns"}, nil
	}

	outcome := MigrateOutcome{}
	err := kv.write(func(tx *sql.Tx) error {
		sourceHolds, err := namespaceHoldsData(tx, from)
		if err != nil {
			return err
		}
		if !sourceHolds {
			// After a move the source is empty, so the next call lands here:
			// idempotent by construction rather than by a flag.
			outcome = MigrateOutcome{Migrated: false, Reason: "source-empty"}
			return nil
		}
		destinationHolds, err := namespaceHoldsData(tx, to)
		if err != nil {
			return err
		}
		if destinationHolds {
			return fmt.Errorf(
				"store: both %s and %s hold data — merging them cannot be done safely, and losing one silently is worse",
				from, to)
		}
		for _, table := range []string{"kv", "records", "meta_collections"} {
			if _, err := tx.Exec("UPDATE "+quoteIdentifier(table)+" SET ns=? WHERE ns=?", to, from); err != nil {
				return fmt.Errorf("store: moving the %s rows of %s: %w", table, from, err)
			}
		}
		outcome = MigrateOutcome{Migrated: true, Reason: "moved"}
		return nil
	})
	if err != nil {
		return MigrateOutcome{}, err
	}
	return outcome, nil
}

func namespaceHoldsData(q querier, ns string) (bool, error) {
	for _, table := range []string{"kv", "records"} {
		var one int
		err := q.QueryRow("SELECT 1 FROM "+quoteIdentifier(table)+" WHERE ns=? LIMIT 1", ns).Scan(&one)
		switch err {
		case nil:
			return true, nil
		case sql.ErrNoRows:
		default:
			return false, fmt.Errorf("store: looking for the %s rows of %s: %w", table, ns, err)
		}
	}
	return false, nil
}
