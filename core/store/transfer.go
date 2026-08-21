package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/soksak-ai/soksak-core/core/i18n"
)

// Moving data between stores as text.
//
// This is a transfer, not a snapshot: the stamps are re-made on the way in, and
// the search index is rebuilt from the definitions that travel with it. When an
// exact copy is what is wanted, data_backup and data_restore are the pair.

// ImportResult is what an import applied.
type ImportResult struct {
	Records int `json:"records"`
	KV      int `json:"kv"`
}

type metaLine struct {
	Kind string   `json:"kind"`
	Ns   string   `json:"ns"`
	Coll string   `json:"coll"`
	Idx  []string `json:"idx"`
	Fts  []string `json:"fts"`
}

type recordLine struct {
	Kind  string          `json:"kind"`
	Ns    string          `json:"ns"`
	Coll  string          `json:"coll"`
	Scope string          `json:"scope"`
	ID    string          `json:"id"`
	Doc   json.RawMessage `json:"doc"`
}

type keyLine struct {
	Kind  string          `json:"kind"`
	Ns    string          `json:"ns"`
	Key   string          `json:"k"`
	Value json.RawMessage `json:"v"`
}

// Export writes the store as JSONL: definitions, then records, then keys.
//
// The order is what an import replays — a definition before the records it
// indexes. Keys have no collection, so naming one skips them rather than
// carrying a namespace's keys under a collection they do not belong to.
//
// A row that cannot be encoded fails the export. Dropping such a
// row makes the export look complete; that is the same shape as an answer
// that comes back empty and is read as success.
func (kv *KV) Export(ns, coll *string) (string, error) {
	var lines []string
	err := kv.read(func(db *sql.DB) error {
		metaStatement, metaParams := narrow(
			`SELECT ns,coll,idx_fields,fts_fields FROM meta_collections`, ns, coll)
		err := eachRow(db, metaStatement, metaParams, func(rows *sql.Rows) error {
			var line metaLine
			var indexFields, ftsFields string
			if err := rows.Scan(&line.Ns, &line.Coll, &indexFields, &ftsFields); err != nil {
				return err
			}
			line.Kind = "meta"
			if err := json.Unmarshal([]byte(indexFields), &line.Idx); err != nil {
				return fmt.Errorf("the index fields of %s/%s are unreadable: %w", line.Ns, line.Coll, err)
			}
			if err := json.Unmarshal([]byte(ftsFields), &line.Fts); err != nil {
				return fmt.Errorf("the search fields of %s/%s are unreadable: %w", line.Ns, line.Coll, err)
			}
			return appendLine(&lines, line, fmt.Sprintf("the definition of %s/%s", line.Ns, line.Coll))
		})
		if err != nil {
			return err
		}

		recordStatement, recordParams := narrow(`SELECT ns,coll,scope,id,doc FROM records`, ns, coll)
		err = eachRow(db, recordStatement, recordParams, func(rows *sql.Rows) error {
			var line recordLine
			var doc string
			if err := rows.Scan(&line.Ns, &line.Coll, &line.Scope, &line.ID, &doc); err != nil {
				return err
			}
			line.Kind = "record"
			line.Doc = json.RawMessage(doc)
			return appendLine(&lines, line, fmt.Sprintf("the record %s/%s/%s", line.Ns, line.Coll, line.ID))
		})
		if err != nil {
			return err
		}

		if coll != nil {
			return nil
		}
		keyStatement, keyParams := narrow(`SELECT ns,k,v FROM kv`, ns, nil)
		return eachRow(db, keyStatement, keyParams, func(rows *sql.Rows) error {
			var line keyLine
			var value string
			if err := rows.Scan(&line.Ns, &line.Key, &value); err != nil {
				return err
			}
			line.Kind = "kv"
			line.Value = json.RawMessage(value)
			return appendLine(&lines, line, fmt.Sprintf("the value at %s/%s", line.Ns, line.Key))
		})
	})
	if err != nil {
		return "", fmt.Errorf("store: exporting: %w", err)
	}
	return strings.Join(lines, "\n"), nil
}

func narrow(statement string, ns, coll *string) (string, []any) {
	var conditions []string
	var params []any
	if ns != nil {
		conditions = append(conditions, "ns=?")
		params = append(params, *ns)
	}
	if coll != nil {
		conditions = append(conditions, "coll=?")
		params = append(params, *coll)
	}
	if len(conditions) > 0 {
		statement += " WHERE " + strings.Join(conditions, " AND ")
	}
	return statement, params
}

func eachRow(db *sql.DB, statement string, params []any, scan func(*sql.Rows) error) error {
	rows, err := db.Query(statement, params...)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		if err := scan(rows); err != nil {
			return err
		}
	}
	return rows.Err()
}

func appendLine(lines *[]string, value any, what string) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("%s cannot be written out: %w", what, err)
	}
	*lines = append(*lines, string(encoded))
	return nil
}

// Import applies JSONL: definitions, then records, then keys, in the order the
// lines arrive.
//
// Every line's namespace is validated. A measurement found an unvalidated
// import planting `plugin:probe-lane`, and afterwards no command could read it
// or delete it, because every command validates. A path that creates what the
// rules forbid means the rules are not rules.
//
// An unknown kind is refused with its line number rather than skipped: a typo,
// or a line from a newer format, otherwise disappears while the count still
// looks right.
func (kv *KV) Import(jsonl string, nowMillis int64) (ImportResult, error) {
	result := ImportResult{}
	for index, line := range strings.Split(jsonl, "\n") {
		number := index + 1
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var head struct {
			Kind string `json:"kind"`
			Ns   string `json:"ns"`
		}
		if err := json.Unmarshal([]byte(line), &head); err != nil {
			return result, fmt.Errorf("store: import line %d is unreadable: %w", number, err)
		}
		if err := validateNamespace(head.Ns); err != nil {
			return result, fmt.Errorf("store: import line %d: %w", number, err)
		}
		switch head.Kind {
		case "meta":
			var parsed metaLine
			if err := json.Unmarshal([]byte(line), &parsed); err != nil {
				return result, fmt.Errorf("store: import line %d is not a definition: %w", number, err)
			}
			if err := kv.Define(parsed.Ns, parsed.Coll, parsed.Idx, parsed.Fts); err != nil {
				return result, fmt.Errorf("store: import line %d: %w", number, err)
			}
		case "record":
			var parsed recordLine
			if err := json.Unmarshal([]byte(line), &parsed); err != nil {
				return result, fmt.Errorf("store: import line %d is not a record: %w", number, err)
			}
			var doc map[string]json.RawMessage
			if err := json.Unmarshal(parsed.Doc, &doc); err != nil {
				return result, fmt.Errorf("store: import line %d has no document: %w", number, err)
			}
			if _, err := kv.Put(parsed.Ns, parsed.Coll, parsed.Scope, parsed.ID, doc, nowMillis); err != nil {
				return result, fmt.Errorf("store: import line %d: %w", number, err)
			}
			result.Records++
		case "kv":
			var parsed keyLine
			if err := json.Unmarshal([]byte(line), &parsed); err != nil {
				return result, fmt.Errorf("store: import line %d is not a value: %w", number, err)
			}
			if parsed.Key == "" {
				return result, i18n.Errorf("store.import.noKey", map[string]string{"line": fmt.Sprint(number)})
			}
			// A value that is not JSON is refused here rather than stored. The
			// read side names it — data_kv_entries answers the whole namespace
			// with an error the moment one row is unreadable — so admitting it
			// makes every neighbouring key unreadable through a row nobody
			// asked for. That is the same rule as the paragraph
			// above, in the other spelling: what got in must be able to come
			// back out.
			if !json.Valid(parsed.Value) {
				return result, fmt.Errorf(
					"store: import line %d carries no readable value for %s/%s", number, parsed.Ns, parsed.Key)
			}
			if err := kv.setAt(parsed.Ns, parsed.Key, string(parsed.Value), nowMillis); err != nil {
				return result, fmt.Errorf("store: import line %d: %w", number, err)
			}
			result.KV++
		default:
			return result, i18n.Errorf("store.import.unknownKind", map[string]string{
				"line": fmt.Sprint(number), "kind": head.Kind})
		}
	}
	return result, nil
}
