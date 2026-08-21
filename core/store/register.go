package store

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"sync/atomic"

	"github.com/soksak-ai/soksak-core/core/i18n"
)

// The command boundary for the storage group.
//
// Nothing here reads the environment. The home, the clock, this process's pid,
// and what "alive" means are all supplied, because that is what lets the same
// code answer identically in a window, in a headless server, and in a test.

// Args are one call's parameters. They are decoded per command rather than at
// this boundary: the registry is typed per command, not here.
type Args = map[string]json.RawMessage

// Command is one entry this group answers.
//
// It is spelled in this package's own words rather than the registry's so the
// rules and their tests can be read without a registry at all. Register, in
// register_control.go, is the one place that translates them — `control.Args`
// is assignable to Args, so the translation adds no shape.
type Command struct {
	Name string
	// Owner is "core" throughout: every command here answers with no window,
	// which is what makes a headless process able to answer the same questions.
	Owner   string
	Handler func(Args) (any, error)
}

// ownerCore is the registry's word for a host-independent command, carried as
// text so the registry's type does not have to travel here.
const ownerCore = "core"

// Deps is what the process supplies. Every field is something this package
// could have read for itself and deliberately does not.
type Deps struct {
	// KV is the open store. A nil handle is a named refusal on every command
	// that needs one, never an empty answer.
	KV *KV
	// Home is where plugins-data and the default backup destination live.
	Home string
	// NowMillis stamps records and names the default backup. Reading the clock
	// here would let this logic decide "now" for itself, and two calls with the
	// same input would then differ.
	NowMillis func() int64
	// PID names this process's backup work files, so a live owner's file is
	// never taken for crash debris.
	PID int
	// PidAlive answers whether a pid is still running. Asking that is a
	// different question on every platform, so the branch is the caller's.
	PidAlive func(pid int) bool
	// Notify sends a change out. Nil means nobody is listening, which is not
	// an error: admission and delivery have separate owners.
	Notify func(Change)
}

// identifierTail separates two records created in the same millisecond by the
// same process. A finer clock would not: two reads of one can return the same
// value, and a counter within a process cannot.
var identifierTail atomic.Uint64

func (deps Deps) store() (*KV, error) {
	if deps.KV == nil {
		return nil, i18n.Errorf("store.deps.noDatabase", nil)
	}
	return deps.KV, nil
}

func (deps Deps) now() (int64, error) {
	if deps.NowMillis == nil {
		return 0, i18n.Errorf("store.deps.noClock", nil)
	}
	return deps.NowMillis(), nil
}

func (deps Deps) home() (string, error) {
	if deps.Home == "" {
		return "", i18n.Errorf("store.deps.noHome", nil)
	}
	return deps.Home, nil
}

// newIdentifier is time first so ids sort by age, then the process, then a tail
// that separates two within one millisecond. No uuid dependency for something
// this small.
func (deps Deps) newIdentifier(nowMillis int64) string {
	return fmt.Sprintf("%013d-%d-%06d", nowMillis, deps.PID, identifierTail.Add(1)%1_000_000)
}

func (deps Deps) publish(change Change) {
	if deps.Notify == nil {
		return
	}
	deps.Notify(change)
}

func (deps Deps) pluginDataDirectory() (string, error) {
	home, err := deps.home()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "plugins-data"), nil
}

func text(value string) *string { return &value }

// required reads an argument the command cannot answer without. A missing one
// is refused by name rather than defaulted: a default chosen here is a decision
// the caller never made.
func required[T any](args Args, name string) (T, error) {
	var value T
	raw, present := args[name]
	if !present {
		return value, i18n.Errorf("store.args.missing", map[string]string{"name": name})
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return value, fmt.Errorf("store: argument %q: %w", name, err)
	}
	return value, nil
}

// optional reads an argument whose absence is itself an answer — a scope that
// narrows nothing, a limit that means the default.
func optional[T any](args Args, name string) (*T, error) {
	raw, present := args[name]
	if !present || string(raw) == "null" {
		return nil, nil
	}
	var value T
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, fmt.Errorf("store: argument %q: %w", name, err)
	}
	return &value, nil
}

func optionalOr[T any](args Args, name string, fallback T) (T, error) {
	value, err := optional[T](args, name)
	if err != nil {
		return fallback, err
	}
	if value == nil {
		return fallback, nil
	}
	return *value, nil
}

// Commands is everything this group answers.
func Commands(deps Deps) []Command {
	var commands []Command
	commands = append(commands, documentCommands(deps)...)
	commands = append(commands, keyCommands(deps)...)
	commands = append(commands, namespaceCommands(deps)...)
	commands = append(commands, retentionCommands(deps)...)
	commands = append(commands, archiveCommands(deps)...)
	commands = append(commands, pluginDataCommands(deps)...)
	return commands
}

func recordAddress(args Args) (string, string, string, *string, error) {
	ns, err := required[string](args, "ns")
	if err != nil {
		return "", "", "", nil, err
	}
	coll, err := required[string](args, "coll")
	if err != nil {
		return "", "", "", nil, err
	}
	id, err := required[string](args, "id")
	if err != nil {
		return "", "", "", nil, err
	}
	scope, err := optional[string](args, "scope")
	if err != nil {
		return "", "", "", nil, err
	}
	return ns, coll, id, scope, nil
}

func queryRequest(args Args) (QueryRequest, error) {
	request := QueryRequest{}
	ns, err := required[string](args, "ns")
	if err != nil {
		return request, err
	}
	coll, err := required[string](args, "coll")
	if err != nil {
		return request, err
	}
	scope, err := optional[string](args, "scope")
	if err != nil {
		return request, err
	}
	filter, err := optionalOr[map[string]json.RawMessage](args, "filter", nil)
	if err != nil {
		return request, err
	}
	order, err := optionalOr(args, "order", "")
	if err != nil {
		return request, err
	}
	// Newest first unless asked otherwise: what changed last is what a caller
	// listing records is almost always after.
	desc, err := optionalOr(args, "desc", true)
	if err != nil {
		return request, err
	}
	limit, err := optional[int64](args, "limit")
	if err != nil {
		return request, err
	}
	offset, err := optional[int64](args, "offset")
	if err != nil {
		return request, err
	}
	return QueryRequest{
		Ns: ns, Coll: coll, Scope: scope, Filter: filter,
		Order: order, Desc: desc, Limit: limit, Offset: offset,
	}, nil
}

func documentCommands(deps Deps) []Command {
	return []Command{
		{
			Name:  "data_define",
			Owner: ownerCore,
			Handler: func(args Args) (any, error) {
				kv, err := deps.store()
				if err != nil {
					return nil, err
				}
				ns, err := required[string](args, "ns")
				if err != nil {
					return nil, err
				}
				coll, err := required[string](args, "coll")
				if err != nil {
					return nil, err
				}
				indexes, err := optionalOr(args, "indexes", []string{})
				if err != nil {
					return nil, err
				}
				fts, err := optionalOr(args, "fts", []string{})
				if err != nil {
					return nil, err
				}
				return nil, kv.Define(ns, coll, indexes, fts)
			},
		},
		{
			Name:  "data_put",
			Owner: ownerCore,
			Handler: func(args Args) (any, error) {
				kv, err := deps.store()
				if err != nil {
					return nil, err
				}
				ns, err := required[string](args, "ns")
				if err != nil {
					return nil, err
				}
				coll, err := required[string](args, "coll")
				if err != nil {
					return nil, err
				}
				doc, err := required[map[string]json.RawMessage](args, "doc")
				if err != nil {
					return nil, err
				}
				// An absent scope is the empty scope, which is a real scope
				// rather than a wildcard: a record is written into one.
				scope, err := optionalOr(args, "scope", "")
				if err != nil {
					return nil, err
				}
				nowMillis, err := deps.now()
				if err != nil {
					return nil, err
				}
				id, err := optionalOr(args, "id", deps.newIdentifier(nowMillis))
				if err != nil {
					return nil, err
				}
				written, err := kv.Put(ns, coll, scope, id, doc, nowMillis)
				if err != nil {
					return nil, err
				}
				deps.publish(Change{Ns: ns, Coll: text(coll), Scope: text(scope), Op: OpPut, ID: text(written)})
				return written, nil
			},
		},
		{
			Name:  "data_get",
			Owner: ownerCore,
			Handler: func(args Args) (any, error) {
				kv, err := deps.store()
				if err != nil {
					return nil, err
				}
				ns, coll, id, scope, err := recordAddress(args)
				if err != nil {
					return nil, err
				}
				doc, found, err := kv.GetDocument(ns, coll, id, scope)
				if err != nil {
					return nil, err
				}
				if !found {
					// A record never written is null, not an error.
					return nil, nil
				}
				return doc, nil
			},
		},
		{
			Name:  "data_delete",
			Owner: ownerCore,
			Handler: func(args Args) (any, error) {
				kv, err := deps.store()
				if err != nil {
					return nil, err
				}
				ns, coll, id, scope, err := recordAddress(args)
				if err != nil {
					return nil, err
				}
				removed, err := kv.DeleteDocument(ns, coll, id, scope)
				if err != nil {
					return nil, err
				}
				if removed {
					deps.publish(Change{Ns: ns, Coll: text(coll), Scope: scope, Op: OpDelete, ID: text(id)})
				}
				return removed, nil
			},
		},
		{
			Name:  "data_query",
			Owner: ownerCore,
			Handler: func(args Args) (any, error) {
				kv, err := deps.store()
				if err != nil {
					return nil, err
				}
				request, err := queryRequest(args)
				if err != nil {
					return nil, err
				}
				return kv.Query(request)
			},
		},
		{
			Name:  "data_count",
			Owner: ownerCore,
			Handler: func(args Args) (any, error) {
				kv, err := deps.store()
				if err != nil {
					return nil, err
				}
				request, err := queryRequest(args)
				if err != nil {
					return nil, err
				}
				return kv.Count(request)
			},
		},
		{
			Name:  "data_search",
			Owner: ownerCore,
			Handler: func(args Args) (any, error) {
				kv, err := deps.store()
				if err != nil {
					return nil, err
				}
				ns, err := required[string](args, "ns")
				if err != nil {
					return nil, err
				}
				coll, err := required[string](args, "coll")
				if err != nil {
					return nil, err
				}
				query, err := required[string](args, "query")
				if err != nil {
					return nil, err
				}
				scope, err := optional[string](args, "scope")
				if err != nil {
					return nil, err
				}
				limit, err := optional[int64](args, "limit")
				if err != nil {
					return nil, err
				}
				return kv.Search(ns, coll, query, scope, limit)
			},
		},
	}
}

func keyCommands(deps Deps) []Command {
	return []Command{
		{
			Name:  "data_kv_delete",
			Owner: ownerCore,
			Handler: func(args Args) (any, error) {
				kv, err := deps.store()
				if err != nil {
					return nil, err
				}
				ns, err := required[string](args, "ns")
				if err != nil {
					return nil, err
				}
				key, err := required[string](args, "key")
				if err != nil {
					return nil, err
				}
				removed, err := kv.DeleteKey(ns, key)
				if err != nil {
					return nil, err
				}
				if removed {
					deps.publish(Change{Ns: ns, Op: OpKVDelete, ID: text(key)})
				}
				return removed, nil
			},
		},
		{
			Name:  "data_kv_keys",
			Owner: ownerCore,
			Handler: func(args Args) (any, error) {
				kv, err := deps.store()
				if err != nil {
					return nil, err
				}
				ns, err := required[string](args, "ns")
				if err != nil {
					return nil, err
				}
				prefix, err := optional[string](args, "prefix")
				if err != nil {
					return nil, err
				}
				return kv.Keys(ns, prefix)
			},
		},
		{
			Name:  "data_kv_entries",
			Owner: ownerCore,
			Handler: func(args Args) (any, error) {
				kv, err := deps.store()
				if err != nil {
					return nil, err
				}
				ns, err := required[string](args, "ns")
				if err != nil {
					return nil, err
				}
				prefix, err := optional[string](args, "prefix")
				if err != nil {
					return nil, err
				}
				return kv.Entries(ns, prefix)
			},
		},
		{
			Name:  "data_kv_delete_many",
			Owner: ownerCore,
			Handler: func(args Args) (any, error) {
				kv, err := deps.store()
				if err != nil {
					return nil, err
				}
				ns, err := required[string](args, "ns")
				if err != nil {
					return nil, err
				}
				keys, err := required[[]string](args, "keys")
				if err != nil {
					return nil, err
				}
				result, err := kv.DeleteMany(ns, keys)
				if err != nil {
					return nil, err
				}
				if result.Deleted > 0 {
					// One fact per batch, with no id: a subscriber re-reads the
					// keys it cares about rather than being told about each.
					deps.publish(Change{Ns: ns, Op: OpKVDelete})
				}
				return result, nil
			},
		},
	}
}

func namespaceCommands(deps Deps) []Command {
	return []Command{
		{
			Name:  "data_ns_remove",
			Owner: ownerCore,
			Handler: func(args Args) (any, error) {
				kv, err := deps.store()
				if err != nil {
					return nil, err
				}
				ns, err := required[string](args, "ns")
				if err != nil {
					return nil, err
				}
				removal, err := kv.RemoveNamespace(ns)
				if err != nil {
					return nil, err
				}
				if removal.Collections+removal.Records+removal.KV > 0 {
					// A namespace that held nothing publishes nothing: a change
					// fact for something that did not happen sends every
					// subscriber to re-read on a statement that was not true.
					deps.publish(Change{Ns: ns, Op: OpNsRemove})
				}
				return removal, nil
			},
		},
		{
			Name:  "data_migrate_ns",
			Owner: ownerCore,
			Handler: func(args Args) (any, error) {
				kv, err := deps.store()
				if err != nil {
					return nil, err
				}
				from, err := required[string](args, "fromNs")
				if err != nil {
					return nil, err
				}
				to, err := required[string](args, "toNs")
				if err != nil {
					return nil, err
				}
				outcome, err := kv.MigrateNamespace(from, to)
				if err != nil {
					return nil, err
				}
				if outcome.Migrated {
					deps.publish(Change{Ns: to, Op: OpNsMigrate})
				}
				return outcome, nil
			},
		},
	}
}

func retentionCommands(deps Deps) []Command {
	return []Command{
		{
			Name:  "data_retention_trim",
			Owner: ownerCore,
			Handler: func(args Args) (any, error) {
				kv, err := deps.store()
				if err != nil {
					return nil, err
				}
				ns, err := required[string](args, "ns")
				if err != nil {
					return nil, err
				}
				coll, err := required[string](args, "coll")
				if err != nil {
					return nil, err
				}
				scope, err := required[string](args, "scope")
				if err != nil {
					return nil, err
				}
				capacity, err := required[int64](args, "cap")
				if err != nil {
					return nil, err
				}
				deleted, err := kv.Trim(ns, coll, scope, capacity)
				if err != nil {
					return nil, err
				}
				if deleted > 0 {
					deps.publish(Change{Ns: ns, Coll: text(coll), Scope: text(scope), Op: OpTrim})
				}
				return deleted, nil
			},
		},
		{
			Name:  "data_retention_reap",
			Owner: ownerCore,
			Handler: func(args Args) (any, error) {
				kv, err := deps.store()
				if err != nil {
					return nil, err
				}
				ns, err := required[string](args, "ns")
				if err != nil {
					return nil, err
				}
				coll, err := required[string](args, "coll")
				if err != nil {
					return nil, err
				}
				cutoff, err := required[int64](args, "cutoffMs")
				if err != nil {
					return nil, err
				}
				deleted, err := kv.Reap(ns, coll, cutoff)
				if err != nil {
					return nil, err
				}
				if deleted > 0 {
					deps.publish(Change{Ns: ns, Coll: text(coll), Op: OpReap})
				}
				return deleted, nil
			},
		},
	}
}

func archiveCommands(deps Deps) []Command {
	return []Command{
		{
			Name:  "data_export",
			Owner: ownerCore,
			Handler: func(args Args) (any, error) {
				kv, err := deps.store()
				if err != nil {
					return nil, err
				}
				ns, err := optional[string](args, "ns")
				if err != nil {
					return nil, err
				}
				coll, err := optional[string](args, "coll")
				if err != nil {
					return nil, err
				}
				return kv.Export(ns, coll)
			},
		},
		{
			Name:  "data_import",
			Owner: ownerCore,
			Handler: func(args Args) (any, error) {
				kv, err := deps.store()
				if err != nil {
					return nil, err
				}
				jsonl, err := required[string](args, "jsonl")
				if err != nil {
					return nil, err
				}
				nowMillis, err := deps.now()
				if err != nil {
					return nil, err
				}
				result, err := kv.Import(jsonl, nowMillis)
				if err != nil {
					return nil, err
				}
				// Nothing here can be pinned to one namespace, so the whole
				// store is named and every subscriber re-reads.
				deps.publish(Change{Ns: WholeStore, Op: OpImport})
				return result, nil
			},
		},
		{
			Name:  "data_backup",
			Owner: ownerCore,
			Handler: func(args Args) (any, error) {
				kv, err := deps.store()
				if err != nil {
					return nil, err
				}
				destination, err := optional[string](args, "path")
				if err != nil {
					return nil, err
				}
				if destination == nil {
					home, err := deps.home()
					if err != nil {
						return nil, err
					}
					nowMillis, err := deps.now()
					if err != nil {
						return nil, err
					}
					// Resolved once, here, and carried back in the answer: a
					// default computed on both sides is two processes writing
					// different files, each believing it wrote the one.
					destination = text(filepath.Join(home, "backups", fmt.Sprintf("soksak-%d.db", nowMillis)))
				}
				return kv.Backup(*destination, deps.PID)
			},
		},
		{
			Name:  "data_restore",
			Owner: ownerCore,
			Handler: func(args Args) (any, error) {
				kv, err := deps.store()
				if err != nil {
					return nil, err
				}
				path, err := required[string](args, "path")
				if err != nil {
					return nil, err
				}
				nowMillis, err := deps.now()
				if err != nil {
					return nil, err
				}
				if err := kv.Restore(path, nowMillis); err != nil {
					return nil, err
				}
				deps.publish(Change{Ns: WholeStore, Op: OpRestore})
				return nil, nil
			},
		},
		{
			Name:  "data_reclaim",
			Owner: ownerCore,
			Handler: func(args Args) (any, error) {
				kv, err := deps.store()
				if err != nil {
					return nil, err
				}
				if deps.PidAlive == nil {
					return nil, fmt.Errorf(
						"store: this process supplied no way to ask whether a pid is alive, and reclaiming without one deletes what somebody else is building")
				}
				// The two places this build can put a work file: beside the
				// store, and in the default backup directory. A backup taken to
				// a directory the caller named leaves its work file there, and
				// this does not reach it — that directory is not this process's
				// to enumerate.
				directories := []string{filepath.Dir(kv.Path())}
				if deps.Home != "" {
					directories = append(directories, filepath.Join(deps.Home, "backups"))
				}
				reclaimed, err := reclaimScratch(directories, deps.PidAlive)
				if err != nil {
					return nil, err
				}
				return ReclaimResult{Reclaimed: reclaimed}, nil
			},
		},
		{
			Name:  "data_verify",
			Owner: ownerCore,
			Handler: func(args Args) (any, error) {
				kv, err := deps.store()
				if err != nil {
					return nil, err
				}
				// A sick store is not a failed command: the answer is the list
				// of what is wrong, even when the diagnosis could not finish.
				return kv.Verify(), nil
			},
		},
		{
			Name:  "data_repair",
			Owner: ownerCore,
			Handler: func(args Args) (any, error) {
				kv, err := deps.store()
				if err != nil {
					return nil, err
				}
				return kv.Repair()
			},
		},
	}
}

func pluginDataCommands(deps Deps) []Command {
	return []Command{
		{
			Name:  "plugin_data_read",
			Owner: ownerCore,
			Handler: func(args Args) (any, error) {
				base, err := deps.pluginDataDirectory()
				if err != nil {
					return nil, err
				}
				id, err := required[string](args, "id")
				if err != nil {
					return nil, err
				}
				key, err := required[string](args, "key")
				if err != nil {
					return nil, err
				}
				value, found, err := readPluginData(base, id, key)
				if err != nil {
					return nil, err
				}
				if !found {
					return nil, nil
				}
				return value, nil
			},
		},
		{
			Name:  "plugin_data_write",
			Owner: ownerCore,
			Handler: func(args Args) (any, error) {
				base, err := deps.pluginDataDirectory()
				if err != nil {
					return nil, err
				}
				id, err := required[string](args, "id")
				if err != nil {
					return nil, err
				}
				key, err := required[string](args, "key")
				if err != nil {
					return nil, err
				}
				value, err := required[string](args, "value")
				if err != nil {
					return nil, err
				}
				return nil, writePluginData(base, id, key, value)
			},
		},
		{
			Name:  "plugin_data_list",
			Owner: ownerCore,
			Handler: func(args Args) (any, error) {
				base, err := deps.pluginDataDirectory()
				if err != nil {
					return nil, err
				}
				id, err := required[string](args, "id")
				if err != nil {
					return nil, err
				}
				return listPluginData(base, id)
			},
		},
	}
}
