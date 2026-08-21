package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/soksak-ai/soksak-core/core/i18n"
)

// Collections of documents: define, put, get, delete, query, count, search.
//
// Every statement is built here, beside the rule it serves. The SQL never
// travels to a caller: two writers of the same query drift, and a drifted query
// is not an error — it is a different answer.

const (
	// sealedEnvelopeKey is the field a sealed record would occupy. This build
	// has no vault, so nothing writes it — but refusing it is the one thing
	// that keeps ciphertext from entering here and being served as a document.
	sealedEnvelopeKey = "__enc"

	// The trigram tokenizer's own floor. Below three codepoints MATCH returns
	// nothing at all, and "nothing at all" is indistinguishable from "no
	// results" — which is the failure shape this whole store is written
	// against, so a short query takes the scan instead.
	trigramFloor = 3

	queryLimitDefault   = 200
	queryLimitCeiling   = 5000
	searchLimitDefault  = 50
	searchLimitCeiling  = 2000
	reclaimedPagesBatch = 256
)

const (
	upsertMetaSQL = `INSERT INTO meta_collections(ns,coll,idx_fields,fts_fields) VALUES(?,?,?,?)
		ON CONFLICT(ns,coll) DO UPDATE SET idx_fields=excluded.idx_fields, fts_fields=excluded.fts_fields`
	selectMetaSQL   = `SELECT cid, idx_fields, fts_fields FROM meta_collections WHERE ns=? AND coll=?`
	upsertRecordSQL = `INSERT INTO records(ns,coll,scope,id,doc,created,updated) VALUES(?,?,?,?,?,?,?)
		ON CONFLICT(ns,coll,id) DO UPDATE SET scope=excluded.scope, doc=excluded.doc, updated=excluded.updated`
	selectRowidSQL  = `SELECT rowid FROM records WHERE ns=? AND coll=? AND id=?`
	deleteRecordSQL = `DELETE FROM records WHERE rowid=?`
	// The prefix is compared literally rather than as a LIKE pattern. An index
	// name holds `_` between the collection id and the field, and `_` is LIKE's
	// single-character wildcard: `idx_1_%` also matches `idx_15_title`, so
	// collection 1 was dropping collections 10 to 19 by name. Measured here on
	// 2026-08-15, on a define that declared nothing new.
	selectIndexSQL = `SELECT name FROM sqlite_master WHERE type='index' AND substr(name, 1, ?)=?`
)

// querier is whatever can answer, so one body serves both a transaction and the
// handle. Inside a transaction it is always the *sql.Tx: this process holds one
// connection, and the transaction is holding it.
type querier interface {
	Exec(query string, args ...any) (sql.Result, error)
	Query(query string, args ...any) (*sql.Rows, error)
	QueryRow(query string, args ...any) *sql.Row
}

type collection struct {
	cid   int64
	index []string
	fts   []string
}

func ftsTable(cid int64) string { return fmt.Sprintf("fts_%d", cid) }

func indexName(cid int64, field string) string { return fmt.Sprintf("idx_%d_%s", cid, field) }

// collectionMeta answers nil when the collection was never defined. That is an
// ordinary state: a collection with no declared indexes still takes writes and
// still answers reads on its built-in fields.
func collectionMeta(q querier, ns, coll string) (*collection, error) {
	var found collection
	var indexFields, ftsFields string
	switch err := q.QueryRow(selectMetaSQL, ns, coll).Scan(&found.cid, &indexFields, &ftsFields); err {
	case nil:
	case sql.ErrNoRows:
		return nil, nil
	default:
		return nil, fmt.Errorf("store: reading the definition of %s/%s: %w", ns, coll, err)
	}
	if err := json.Unmarshal([]byte(indexFields), &found.index); err != nil {
		return nil, fmt.Errorf("store: the index fields of %s/%s are unreadable: %w", ns, coll, err)
	}
	if err := json.Unmarshal([]byte(ftsFields), &found.fts); err != nil {
		return nil, fmt.Errorf("store: the search fields of %s/%s are unreadable: %w", ns, coll, err)
	}
	return &found, nil
}

// Define declares a collection's indexes and search fields. It is idempotent,
// and it drops the expression indexes the collection no longer declares —
// leaving them behind keeps making every other namespace's writes to records
// heavier, which is the reason for dropping them when a
// namespace is removed but does not apply here.
func (kv *KV) Define(ns, coll string, indexes, fts []string) error {
	// A define creates a namespace, so it validates one. Removal does not, and
	// that asymmetry is the point: what got in must be able to get out.
	if err := validateNamespace(ns); err != nil {
		return err
	}
	if err := validateCollection(coll); err != nil {
		return err
	}
	for _, field := range append(append([]string{}, indexes...), fts...) {
		if err := validateField(field); err != nil {
			return err
		}
	}
	indexFields, err := json.Marshal(nonNil(indexes))
	if err != nil {
		return fmt.Errorf("store: the index fields of %s/%s: %w", ns, coll, err)
	}
	ftsFields, err := json.Marshal(nonNil(fts))
	if err != nil {
		return fmt.Errorf("store: the search fields of %s/%s: %w", ns, coll, err)
	}

	return kv.write(func(tx *sql.Tx) error {
		if _, err := tx.Exec(upsertMetaSQL, ns, coll, string(indexFields), string(ftsFields)); err != nil {
			return fmt.Errorf("store: defining %s/%s: %w", ns, coll, err)
		}
		meta, err := collectionMeta(tx, ns, coll)
		if err != nil {
			return err
		}
		if meta == nil {
			return i18n.Errorf("store.define.missingAfterWrite", map[string]string{"ns": ns, "coll": coll})
		}
		if len(fts) > 0 {
			// trigram is what makes a CJK substring findable at all; a word
			// tokenizer has no word boundaries to find there.
			statement := fmt.Sprintf(
				"CREATE VIRTUAL TABLE IF NOT EXISTS %s USING fts5(text, tokenize='trigram')",
				ftsTable(meta.cid))
			if _, err := tx.Exec(statement); err != nil {
				return fmt.Errorf("store: creating the search index of %s/%s: %w", ns, coll, err)
			}
		} else if _, err := tx.Exec("DROP TABLE IF EXISTS " + quoteIdentifier(ftsTable(meta.cid))); err != nil {
			// A collection that declares no search fields is not indexed by
			// put and delete, so a table left here stops being told what
			// happened while it stands. Re-declaring search then reuses it,
			// and a rowid the meantime handed to another record answers with
			// the deleted record's words: search returning a document that
			// never held the query. Measured here on 2026-08-15 — searching
			// "alphabet" answered a document reading "bravado". Dropping it is
			// the same rule as the indexes below, for the same reason.
			return fmt.Errorf("store: removing the search index of %s/%s: %w", ns, coll, err)
		}
		if err := dropUndeclaredIndexes(tx, meta.cid, indexes); err != nil {
			return err
		}
		for _, field := range indexes {
			statement := fmt.Sprintf(
				"CREATE INDEX IF NOT EXISTS %s ON records(ns, coll, json_extract(doc, '$.%s'))",
				indexName(meta.cid, field), field)
			if _, err := tx.Exec(statement); err != nil {
				return fmt.Errorf("store: indexing %s of %s/%s: %w", field, ns, coll, err)
			}
		}
		return nil
	})
}

func dropUndeclaredIndexes(q querier, cid int64, declared []string) error {
	keep := make(map[string]struct{}, len(declared))
	for _, field := range declared {
		keep[indexName(cid, field)] = struct{}{}
	}
	prefix := fmt.Sprintf("idx_%d_", cid)
	rows, err := q.Query(selectIndexSQL, len(prefix), prefix)
	if err != nil {
		return fmt.Errorf("store: reading the indexes of collection %d: %w", cid, err)
	}
	var stale []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			_ = rows.Close()
			return fmt.Errorf("store: reading an index name: %w", err)
		}
		if _, wanted := keep[name]; !wanted {
			stale = append(stale, name)
		}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return fmt.Errorf("store: reading the indexes of collection %d: %w", cid, err)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("store: reading the indexes of collection %d: %w", cid, err)
	}
	for _, name := range stale {
		if _, err := q.Exec("DROP INDEX IF EXISTS " + quoteIdentifier(name)); err != nil {
			return fmt.Errorf("store: dropping the index %s: %w", name, err)
		}
	}
	return nil
}

// Put writes one document and its search index in one transaction.
//
// Naming the stage a write failed at matters, because the same wording
// came from two stages and tracing became guesswork. That is kept; what is not
// kept is its retry around `out of memory`, which guarded a C allocator
// returning NULL under an rlimit. This driver allocates from the Go heap, where
// that condition cannot arrive as a recoverable error, and a retry around a
// condition that cannot occur only ever hides the first real failure.
func (kv *KV) Put(ns, coll, scope, id string, doc map[string]json.RawMessage, nowMillis int64) (string, error) {
	if err := validateNamespace(ns); err != nil {
		return "", err
	}
	if err := validateCollection(coll); err != nil {
		return "", err
	}
	if doc == nil {
		return "", i18n.Errorf("store.put.documentNotObject", map[string]string{"ns": ns, "coll": coll})
	}
	if _, sealed := doc[sealedEnvelopeKey]; sealed {
		return "", i18n.Errorf("store.put.reservedKey", map[string]string{
			"ns": ns, "coll": coll, "key": sealedEnvelopeKey,
		})
	}
	if id == "" {
		return "", i18n.Errorf("store.put.recordNoID", map[string]string{"ns": ns, "coll": coll})
	}

	// The canonical id goes into the document, so doc.id always equals the
	// record id and no caller can address one by the other.
	stored := make(map[string]json.RawMessage, len(doc)+1)
	for key, value := range doc {
		stored[key] = value
	}
	identifier, err := json.Marshal(id)
	if err != nil {
		return "", fmt.Errorf("store: the id %q cannot be written into the document: %w", id, err)
	}
	stored["id"] = identifier
	encoded, err := json.Marshal(stored)
	if err != nil {
		return "", fmt.Errorf("store: the document %s/%s/%s cannot be encoded: %w", ns, coll, id, err)
	}

	err = kv.write(func(tx *sql.Tx) error {
		meta, err := collectionMeta(tx, ns, coll)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(upsertRecordSQL, ns, coll, scope, id, string(encoded), nowMillis, nowMillis); err != nil {
			return fmt.Errorf("store: records write: %w", err)
		}
		return syncSearchIndex(tx, meta, ns, coll, id, stored)
	})
	if err != nil {
		return "", err
	}
	return id, nil
}

// syncSearchIndex replaces one record's search text. It runs inside the put's
// transaction so a record is never present with a stale index.
func syncSearchIndex(tx *sql.Tx, meta *collection, ns, coll, id string, doc map[string]json.RawMessage) error {
	if meta == nil || len(meta.fts) == 0 {
		return nil
	}
	table := ftsTable(meta.cid)
	var rowid int64
	if err := tx.QueryRow(selectRowidSQL, ns, coll, id).Scan(&rowid); err != nil {
		return fmt.Errorf("store: fts index (%s): finding the row: %w", table, err)
	}
	if _, err := tx.Exec(fmt.Sprintf("DELETE FROM %s WHERE rowid=?", table), rowid); err != nil {
		return fmt.Errorf("store: fts index (%s): %w", table, err)
	}
	text := searchText(doc, meta.fts)
	if text == "" {
		return nil
	}
	statement := fmt.Sprintf("INSERT INTO %s(rowid, text) VALUES(?, ?)", table)
	if _, err := tx.Exec(statement, rowid, text); err != nil {
		return fmt.Errorf("store: fts index (%s, %d chars): %w", table, utf8.RuneCountInString(text), err)
	}
	return nil
}

// searchText is the declared search fields' string values, space separated. A
// field holding something other than a string contributes nothing: indexing its
// JSON text would make punctuation searchable and call it content.
func searchText(doc map[string]json.RawMessage, fields []string) string {
	parts := make([]string, 0, len(fields))
	for _, field := range fields {
		raw, present := doc[field]
		if !present {
			continue
		}
		var value string
		if err := json.Unmarshal(raw, &value); err != nil {
			continue
		}
		parts = append(parts, value)
	}
	return strings.Join(parts, " ")
}

// GetDocument reads one record. An id never written is absence, not failure. A
// scope narrows when it is given and matches every scope when it is not.
func (kv *KV) GetDocument(ns, coll, id string, scope *string) (json.RawMessage, bool, error) {
	if err := validateNamespace(ns); err != nil {
		return nil, false, err
	}
	if err := validateCollection(coll); err != nil {
		return nil, false, err
	}
	statement := `SELECT doc FROM records WHERE ns=? AND coll=? AND id=?`
	params := []any{ns, coll, id}
	if scope != nil {
		statement += ` AND scope=?`
		params = append(params, *scope)
	}
	var doc string
	var found bool
	err := kv.read(func(db *sql.DB) error {
		switch err := db.QueryRow(statement, params...).Scan(&doc); err {
		case nil:
			found = true
			return nil
		case sql.ErrNoRows:
			return nil
		default:
			return fmt.Errorf("store: reading %s/%s/%s: %w", ns, coll, id, err)
		}
	})
	if err != nil || !found {
		return nil, false, err
	}
	return json.RawMessage(doc), true, nil
}

// DeleteDocument removes one record and its search row together. False means it
// was not there, which is an answer rather than a failure.
func (kv *KV) DeleteDocument(ns, coll, id string, scope *string) (bool, error) {
	if err := validateNamespace(ns); err != nil {
		return false, err
	}
	if err := validateCollection(coll); err != nil {
		return false, err
	}
	statement := selectRowidSQL
	params := []any{ns, coll, id}
	if scope != nil {
		statement += ` AND scope=?`
		params = append(params, *scope)
	}
	removed := false
	err := kv.write(func(tx *sql.Tx) error {
		var rowid int64
		switch err := tx.QueryRow(statement, params...).Scan(&rowid); err {
		case nil:
		case sql.ErrNoRows:
			return nil
		default:
			return fmt.Errorf("store: finding %s/%s/%s: %w", ns, coll, id, err)
		}
		meta, err := collectionMeta(tx, ns, coll)
		if err != nil {
			return err
		}
		if err := deleteRows(tx, meta, []int64{rowid}); err != nil {
			return err
		}
		removed = true
		return nil
	})
	return removed, err
}

// deleteRows removes whole records: the search row and the record row for every
// rowid, inside the caller's transaction. Never a record present with its index
// gone, and never the reverse.
func deleteRows(tx *sql.Tx, meta *collection, rowids []int64) error {
	if len(rowids) == 0 {
		return nil
	}
	if meta != nil && len(meta.fts) > 0 {
		table := ftsTable(meta.cid)
		statement := fmt.Sprintf("DELETE FROM %s WHERE rowid=?", table)
		for _, rowid := range rowids {
			if _, err := tx.Exec(statement, rowid); err != nil {
				return fmt.Errorf("store: fts index (%s): %w", table, err)
			}
		}
	}
	for _, rowid := range rowids {
		if _, err := tx.Exec(deleteRecordSQL, rowid); err != nil {
			return fmt.Errorf("store: deleting a record: %w", err)
		}
	}
	return nil
}

// QueryRequest is one data_query or data_count. Absent limits are pointers
// because an explicit zero means "no records" and no limit at all means 200 —
// folding them together makes one of those unsayable.
type QueryRequest struct {
	Ns     string
	Coll   string
	Scope  *string
	Filter map[string]json.RawMessage
	Order  string
	Desc   bool
	Limit  *int64
	Offset *int64
}

func clamp(value, low, high int64) int64 {
	if value < low {
		return low
	}
	if value > high {
		return high
	}
	return value
}

func window(limit *int64, fallback, ceiling int64) int64 {
	if limit == nil {
		return fallback
	}
	return clamp(*limit, 0, ceiling)
}

// queryStatement compiles one request. The window is bound rather than spliced:
// nothing about a limit needs to be part of the statement's identity.
func (kv *KV) queryStatement(request QueryRequest) (string, []any, error) {
	if err := validateNamespace(request.Ns); err != nil {
		return "", nil, err
	}
	if err := validateCollection(request.Coll); err != nil {
		return "", nil, err
	}
	var allowed []string
	err := kv.read(func(db *sql.DB) error {
		meta, err := collectionMeta(db, request.Ns, request.Coll)
		if err != nil {
			return err
		}
		if meta != nil {
			allowed = meta.index
		}
		return nil
	})
	if err != nil {
		return "", nil, err
	}

	statement := `SELECT doc FROM records WHERE ns=? AND coll=?`
	params := []any{request.Ns, request.Coll}
	if request.Scope != nil {
		statement += ` AND scope=?`
		params = append(params, *request.Scope)
	}
	clause, filterParams, err := buildWhere(request.Filter, allowed)
	if err != nil {
		return "", nil, err
	}
	statement += clause
	params = append(params, filterParams...)

	order, err := orderExpression(request.Order, allowed)
	if err != nil {
		return "", nil, err
	}
	direction := "ASC"
	if request.Desc {
		direction = "DESC"
	}
	statement += fmt.Sprintf(" ORDER BY %s %s LIMIT ? OFFSET ?", order, direction)
	offset := int64(0)
	if request.Offset != nil {
		offset = clamp(*request.Offset, 0, int64(1)<<62)
	}
	params = append(params, window(request.Limit, queryLimitDefault, queryLimitCeiling), offset)
	return statement, params, nil
}

// Query answers the records matching one request.
func (kv *KV) Query(request QueryRequest) ([]json.RawMessage, error) {
	statement, params, err := kv.queryStatement(request)
	if err != nil {
		return nil, err
	}
	var docs []json.RawMessage
	err = kv.read(func(db *sql.DB) error {
		docs, err = collectDocuments(db, statement, params)
		return err
	})
	if err != nil {
		return nil, err
	}
	return docs, nil
}

// Count answers how many records match, through the same builder Query uses:
// two builders would drift, and the drift shows as a count that disagrees with
// the list it counts.
func (kv *KV) Count(request QueryRequest) (int64, error) {
	if err := validateNamespace(request.Ns); err != nil {
		return 0, err
	}
	if err := validateCollection(request.Coll); err != nil {
		return 0, err
	}
	var allowed []string
	err := kv.read(func(db *sql.DB) error {
		meta, err := collectionMeta(db, request.Ns, request.Coll)
		if err != nil {
			return err
		}
		if meta != nil {
			allowed = meta.index
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	statement := `SELECT COUNT(*) FROM records WHERE ns=? AND coll=?`
	params := []any{request.Ns, request.Coll}
	if request.Scope != nil {
		statement += ` AND scope=?`
		params = append(params, *request.Scope)
	}
	clause, filterParams, err := buildWhere(request.Filter, allowed)
	if err != nil {
		return 0, err
	}
	statement += clause
	params = append(params, filterParams...)

	var total int64
	err = kv.read(func(db *sql.DB) error {
		if err := db.QueryRow(statement, params...).Scan(&total); err != nil {
			return fmt.Errorf("store: counting %s/%s: %w", request.Ns, request.Coll, err)
		}
		return nil
	})
	return total, err
}

// Search finds records by text. A collection with declared search fields and a
// query of at least three codepoints goes through the trigram index; anything
// shorter takes a scan, because trigram below its floor matches nothing and
// answers that as an empty result.
func (kv *KV) Search(ns, coll, text string, scope *string, limit *int64) ([]json.RawMessage, error) {
	if err := validateNamespace(ns); err != nil {
		return nil, err
	}
	if err := validateCollection(coll); err != nil {
		return nil, err
	}
	var meta *collection
	err := kv.read(func(db *sql.DB) error {
		found, err := collectionMeta(db, ns, coll)
		meta = found
		return err
	})
	if err != nil {
		return nil, err
	}

	bound := window(limit, searchLimitDefault, searchLimitCeiling)
	var statement string
	var params []any
	if meta != nil && len(meta.fts) > 0 && utf8.RuneCountInString(text) >= trigramFloor {
		table := ftsTable(meta.cid)
		statement = fmt.Sprintf(
			`SELECT r.doc FROM %s f JOIN records r ON r.rowid=f.rowid WHERE f.text MATCH ? AND r.ns=? AND r.coll=?`,
			table)
		// Quoted, with inner quotes doubled: the query is text to find, not
		// syntax to obey.
		params = []any{`"` + strings.ReplaceAll(text, `"`, `""`) + `"`, ns, coll}
		if scope != nil {
			statement += ` AND r.scope=?`
			params = append(params, *scope)
		}
		statement += ` ORDER BY r.updated DESC LIMIT ?`
	} else {
		statement = `SELECT doc FROM records WHERE ns=? AND coll=? AND doc LIKE ?`
		params = []any{ns, coll, "%" + text + "%"}
		if scope != nil {
			statement += ` AND scope=?`
			params = append(params, *scope)
		}
		statement += ` ORDER BY updated DESC LIMIT ?`
	}
	params = append(params, bound)

	var docs []json.RawMessage
	err = kv.read(func(db *sql.DB) error {
		docs, err = collectDocuments(db, statement, params)
		return err
	})
	if err != nil {
		return nil, err
	}
	return docs, nil
}

func collectDocuments(q querier, statement string, params []any) ([]json.RawMessage, error) {
	rows, err := q.Query(statement, params...)
	if err != nil {
		return nil, fmt.Errorf("store: reading records: %w", err)
	}
	defer func() { _ = rows.Close() }()
	docs := []json.RawMessage{}
	for rows.Next() {
		var doc string
		if err := rows.Scan(&doc); err != nil {
			return nil, fmt.Errorf("store: reading a record: %w", err)
		}
		docs = append(docs, json.RawMessage(doc))
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: reading records: %w", err)
	}
	return docs, nil
}

// nonNil keeps an absent list from being written as JSON null: a definition
// that reads back as null and one that reads back as [] would then be the same
// row with two meanings.
func nonNil(fields []string) []string {
	if fields == nil {
		return []string{}
	}
	sorted := append([]string{}, fields...)
	sort.Strings(sorted)
	return sorted
}
