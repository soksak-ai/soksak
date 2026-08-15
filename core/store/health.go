package store

import (
	"database/sql"
	"fmt"
)

// The store's own health — seeing it, and doing what can be done about it.
//
// Diagnosis is the full `PRAGMA integrity_check`, not `quick_check`. quick_check
// by design does not cross-check indexes against tables, so index corruption
// walks straight through it — and a store in that state reads fine and only
// breaks on writes, which was measured (2026-07-13) as SQLite
// answering `out of memory` to every insert while every query still worked.

// Repair is what a repair found and what it left.
//
// ReindexError present means the heal was attempted and could not be done,
// which is different from not attempting it.
type Repair struct {
	Before       []string `json:"before"`
	After        []string `json:"after"`
	ReindexError *string  `json:"reindexError,omitempty"`
}

// Verify answers the store's problems. An empty list means healthy.
//
// It returns no error, and that is the rule rather than an omission: a
// diagnosis that cannot finish is a symptom of the damage, and throwing it
// makes "the store is sick" read as "the command failed". A measurement
// measured that misreading, with `out of memory` taken for machine memory
// pressure.
func (kv *KV) Verify() []string {
	problems, err := kv.check()
	if err == nil {
		return problems
	}
	// A full check sweeps the whole store and fails as a whole, so it says
	// nothing about where. Per-table checks are small enough that most pass,
	// and what is left is the part that is actually sick.
	return append([]string{fmt.Sprintf("diagnosis failed: %v", err)}, kv.perTable()...)
}

func (kv *KV) check() ([]string, error) {
	problems := []string{}
	err := kv.read(func(db *sql.DB) error {
		rows, err := db.Query("PRAGMA integrity_check")
		if err != nil {
			return err
		}
		defer func() { _ = rows.Close() }()
		for rows.Next() {
			var line string
			if err := rows.Scan(&line); err != nil {
				return err
			}
			// A clean store answers with the single row "ok", which is not a
			// problem.
			if line != "ok" {
				problems = append(problems, line)
			}
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return problems, nil
}

func (kv *KV) perTable() []string {
	tables, err := kv.names("table")
	if err != nil {
		return []string{fmt.Sprintf("listing the tables failed: %v", err)}
	}
	var problems []string
	for _, table := range tables {
		err := kv.read(func(db *sql.DB) error {
			rows, err := db.Query("PRAGMA integrity_check(" + quoteIdentifier(table) + ")")
			if err != nil {
				return err
			}
			defer func() { _ = rows.Close() }()
			for rows.Next() {
				var line string
				if err := rows.Scan(&line); err != nil {
					return err
				}
				if line != "ok" {
					problems = append(problems, fmt.Sprintf("%s: %s", table, line))
				}
			}
			return rows.Err()
		})
		if err != nil {
			problems = append(problems, fmt.Sprintf("%s: diagnosis failed: %v", table, err))
		}
	}
	return problems
}

func (kv *KV) names(kind string) ([]string, error) {
	var found []string
	err := kv.read(func(db *sql.DB) error {
		rows, err := db.Query(
			`SELECT name FROM sqlite_master WHERE type=? AND name NOT LIKE 'sqlite_%'`, kind)
		if err != nil {
			return err
		}
		defer func() { _ = rows.Close() }()
		for rows.Next() {
			var name string
			if err := rows.Scan(&name); err != nil {
				return err
			}
			found = append(found, name)
		}
		return rows.Err()
	})
	return found, err
}

// Repair rebuilds what can be rebuilt, then diagnoses again and shows what is
// left. It never claims a heal it did not achieve, and it creates and deletes
// no rows.
//
// Repair does not gate on a successful diagnosis. The worse the damage, the
// earlier diagnosis fails; making it a precondition closes repair at exactly
// the moment it is needed.
func (kv *KV) Repair() (Repair, error) {
	outcome := Repair{Before: kv.Verify()}

	// The write-ahead log first: cheapest, with nothing to undo. A log that has
	// grown carries an index of itself that grows with it, and writes and full
	// checks break on that before anything else. If this heals it, the damage
	// was never damage.
	checkpointFailed := kv.exec("PRAGMA wal_checkpoint(TRUNCATE)") != nil
	if !checkpointFailed && len(kv.Verify()) == 0 {
		outcome.After = kv.Verify()
		return outcome, nil
	}

	var reindexError string
	if err := kv.exec("REINDEX"); err != nil {
		// One stuck index kills the batch for all of them, so what can be
		// rebuilt is rebuilt and only what stays stuck is named.
		stuck := kv.reindexEach()
		if len(stuck) > 0 {
			reindexError = fmt.Sprintf("the batch failed and these could not be rebuilt one by one: %v", stuck)
		}
	}
	if len(kv.Verify()) > 0 {
		// Rebuilding indexes does not reach the tables themselves. VACUUM
		// rewrites the store from its logical content — the rows stay as they
		// are — and folds the log.
		if err := kv.exec("VACUUM"); err != nil {
			if reindexError == "" {
				reindexError = fmt.Sprintf("VACUUM: %v", err)
			} else {
				reindexError = fmt.Sprintf("%s / VACUUM: %v", reindexError, err)
			}
		}
	}
	if reindexError != "" {
		outcome.ReindexError = &reindexError
	}
	outcome.After = kv.Verify()
	return outcome, nil
}

func (kv *KV) reindexEach() []string {
	names, err := kv.names("index")
	if err != nil {
		return []string{fmt.Sprintf("listing the indexes failed: %v", err)}
	}
	var stuck []string
	for _, name := range names {
		if err := kv.exec("REINDEX " + quoteIdentifier(name)); err != nil {
			stuck = append(stuck, name)
		}
	}
	return stuck
}

func (kv *KV) exec(statement string) error {
	return kv.read(func(db *sql.DB) error {
		_, err := db.Exec(statement)
		return err
	})
}
