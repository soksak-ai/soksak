package store_test

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/soksak/soksak-core/core/control"
	"github.com/soksak/soksak-core/core/store"
)

var groupCommands = []string{
	"data_get", "data_put", "data_delete", "data_query", "data_search", "data_count",
	"data_define", "data_kv_delete", "data_kv_keys", "data_kv_entries", "data_kv_delete_many",
	"data_ns_remove", "data_migrate_ns", "data_export", "data_import", "data_backup",
	"data_restore", "data_verify", "data_repair", "data_reclaim", "data_retention_reap",
	"data_retention_trim", "plugin_data_read", "plugin_data_write", "plugin_data_list",
}

func arguments(t *testing.T, text string) control.Args {
	t.Helper()
	args := control.Args{}
	if text != "" {
		if err := json.Unmarshal([]byte(text), &args); err != nil {
			t.Fatalf("reading the arguments: %v", err)
		}
	}
	return args
}

func registered(t *testing.T, deps store.Deps) *control.Registry {
	t.Helper()
	registry := control.NewRegistry()
	store.Register(registry, deps)
	return registry
}

func wired(t *testing.T) (*control.Registry, *store.KV, *[]store.Change) {
	t.Helper()
	home := t.TempDir()
	kv, err := store.OpenKV(filepath.Join(home, "data", "soksak.db"))
	if err != nil {
		t.Fatalf("opening: %v", err)
	}
	t.Cleanup(func() { _ = kv.Close() })
	published := []store.Change{}
	registry := registered(t, store.Deps{
		KV:        kv,
		Home:      home,
		NowMillis: func() int64 { return 1000 },
		PID:       4242,
		PidAlive:  func(int) bool { return true },
		Notify:    func(change store.Change) { published = append(published, change) },
	})
	return registry, kv, &published
}

// Every command in this group answers, and every one of them is host
// independent: none of them needs a window.
func TestTheWholeGroupIsRegisteredAsCore(t *testing.T) {
	registry, _, _ := wired(t)
	table := registry.Describe()
	served := map[string]control.Owner{}
	for _, command := range table.Commands {
		served[command.Name] = command.Owner
	}
	for _, name := range groupCommands {
		owner, present := served[name]
		if !present {
			t.Errorf("%s is not registered", name)
			continue
		}
		if owner != control.OwnerCore {
			t.Errorf("%s is owned by %s, want core", name, owner)
		}
	}
	if len(table.Commands) != len(groupCommands) {
		t.Errorf("the group registered %d commands, want %d", len(table.Commands), len(groupCommands))
	}
}

// With no store handle, every command that needs one refuses by name. Answering
// with an empty result and no error would make "this process holds no store"
// read as "there was nothing".
func TestWithNoStoreEveryCommandThatNeedsOneRefusesByName(t *testing.T) {
	registry := registered(t, store.Deps{
		Home: t.TempDir(), NowMillis: func() int64 { return 1 }, PidAlive: func(int) bool { return true }})
	for name, args := range map[string]string{
		"data_get":            `{"ns":"ui","coll":"t","id":"x"}`,
		"data_put":            `{"ns":"ui","coll":"t","doc":{}}`,
		"data_delete":         `{"ns":"ui","coll":"t","id":"x"}`,
		"data_query":          `{"ns":"ui","coll":"t"}`,
		"data_search":         `{"ns":"ui","coll":"t","query":"a"}`,
		"data_count":          `{"ns":"ui","coll":"t"}`,
		"data_define":         `{"ns":"ui","coll":"t"}`,
		"data_kv_delete":      `{"ns":"ui","key":"a"}`,
		"data_kv_keys":        `{"ns":"ui"}`,
		"data_kv_entries":     `{"ns":"ui"}`,
		"data_kv_delete_many": `{"ns":"ui","keys":["a"]}`,
		"data_ns_remove":      `{"ns":"ui"}`,
		"data_migrate_ns":     `{"fromNs":"a","toNs":"b"}`,
		"data_export":         `{}`,
		"data_import":         `{"jsonl":""}`,
		"data_backup":         `{}`,
		"data_restore":        `{"path":"/nowhere"}`,
		"data_verify":         `{}`,
		"data_repair":         `{}`,
		"data_reclaim":        `{}`,
		"data_retention_reap": `{"ns":"ui","coll":"t","cutoffMs":1}`,
		"data_retention_trim": `{"ns":"ui","coll":"t","scope":"","cap":1}`,
	} {
		answer, err := registry.Invoke(name, arguments(t, args))
		if err == nil {
			t.Errorf("%s answered %v with no store", name, answer)
			continue
		}
		if !strings.Contains(err.Error(), "no database handle") {
			t.Errorf("%s refused with %v, want it named", name, err)
		}
	}
}

// The plugin storage commands answer without a store: they are files, and a
// process with no database still holds a home.
func TestThePluginStorageCommandsAnswerWithNoStore(t *testing.T) {
	registry := registered(t, store.Deps{Home: t.TempDir(), NowMillis: func() int64 { return 1 }})
	answer, err := registry.Invoke("plugin_data_list", arguments(t, `{"id":"memo"}`))
	if err != nil {
		t.Fatalf("listing: %v", err)
	}
	keys, ok := answer.([]string)
	if !ok || len(keys) != 0 {
		t.Errorf("answer = %#v, want an empty list", answer)
	}
}

// A value never written is null, not an error.
func TestPluginDataReadAnswersNullForAbsence(t *testing.T) {
	registry := registered(t, store.Deps{Home: t.TempDir()})
	answer, err := registry.Invoke("plugin_data_read", arguments(t, `{"id":"memo","key":"notes"}`))
	if err != nil {
		t.Fatalf("reading: %v", err)
	}
	if answer != nil {
		t.Errorf("answer = %#v, want null", answer)
	}
}

// A record never written is null, not an error.
func TestDataGetAnswersNullForAbsence(t *testing.T) {
	registry, _, _ := wired(t)
	answer, err := registry.Invoke("data_get", arguments(t, `{"ns":"ui","coll":"t","id":"x"}`))
	if err != nil {
		t.Fatalf("reading: %v", err)
	}
	if answer != nil {
		t.Errorf("answer = %#v, want null", answer)
	}
}

// A put with no id is given one, and the whole round trip goes through the
// registry rather than around it.
func TestPutAndGetThroughTheRegistry(t *testing.T) {
	registry, _, _ := wired(t)
	answer, err := registry.Invoke("data_put", arguments(t, `{"ns":"ui","coll":"t","doc":{"n":1}}`))
	if err != nil {
		t.Fatalf("putting: %v", err)
	}
	id, ok := answer.(string)
	if !ok || id == "" {
		t.Fatalf("answer = %#v, want a generated id", answer)
	}
	if !strings.Contains(id, "4242") {
		t.Errorf("id = %q, want this process's pid in it", id)
	}
	read, err := registry.Invoke("data_get",
		arguments(t, `{"ns":"ui","coll":"t","id":`+string(mustEncode(t, id))+`}`))
	if err != nil {
		t.Fatalf("reading back: %v", err)
	}
	if read == nil {
		t.Fatal("the record put through the registry is not there")
	}
}

// Two puts in the same millisecond do not collide: the tail separates them
// within a process, which no clock reading finer would guarantee.
func TestGeneratedIdentifiersDoNotCollideWithinAMillisecond(t *testing.T) {
	registry, _, _ := wired(t)
	seen := map[string]struct{}{}
	for attempt := 0; attempt < 50; attempt++ {
		answer, err := registry.Invoke("data_put", arguments(t, `{"ns":"ui","coll":"t","doc":{"n":1}}`))
		if err != nil {
			t.Fatalf("putting: %v", err)
		}
		id := answer.(string)
		if _, already := seen[id]; already {
			t.Fatalf("the id %q was handed out twice", id)
		}
		seen[id] = struct{}{}
	}
}

// A mutation publishes what changed. Nobody listening is not an error.
func TestAMutationPublishesWhatChanged(t *testing.T) {
	published := []store.Change{}
	home := t.TempDir()
	kv, err := store.OpenKV(filepath.Join(home, "soksak.db"))
	if err != nil {
		t.Fatalf("opening: %v", err)
	}
	t.Cleanup(func() { _ = kv.Close() })
	registry := registered(t, store.Deps{
		KV: kv, Home: home, NowMillis: func() int64 { return 1000 }, PID: 1,
		PidAlive: func(int) bool { return true }, Notify: func(change store.Change) { published = append(published, change) }})

	if _, err := registry.Invoke("data_put", arguments(t, `{"ns":"ui","coll":"t","id":"x","doc":{}}`)); err != nil {
		t.Fatalf("putting: %v", err)
	}
	if len(published) != 1 {
		t.Fatalf("published %d changes, want 1", len(published))
	}
	change := published[0]
	if change.Ns != "ui" || change.Op != store.OpPut || change.ID == nil || *change.ID != "x" {
		t.Errorf("change = %+v", change)
	}
	if change.Coll == nil || *change.Coll != "t" {
		t.Errorf("change = %+v, want the collection named", change)
	}
}

func TestPublishingWithNobodyListeningIsNotAFailure(t *testing.T) {
	home := t.TempDir()
	kv, err := store.OpenKV(filepath.Join(home, "soksak.db"))
	if err != nil {
		t.Fatalf("opening: %v", err)
	}
	t.Cleanup(func() { _ = kv.Close() })
	registry := registered(t, store.Deps{KV: kv, Home: home, NowMillis: func() int64 { return 1 }, PID: 1})
	if _, err := registry.Invoke("data_put", arguments(t, `{"ns":"ui","coll":"t","id":"x","doc":{}}`)); err != nil {
		t.Errorf("putting with nobody listening: %v", err)
	}
}

// A process that supplied no clock cannot stamp a record, and says so rather
// than reading one for itself.
func TestWithNoClockAStampingCommandRefusesByName(t *testing.T) {
	home := t.TempDir()
	kv, err := store.OpenKV(filepath.Join(home, "soksak.db"))
	if err != nil {
		t.Fatalf("opening: %v", err)
	}
	t.Cleanup(func() { _ = kv.Close() })
	registry := registered(t, store.Deps{KV: kv, Home: home, PID: 1})
	_, err = registry.Invoke("data_put", arguments(t, `{"ns":"ui","coll":"t","id":"x","doc":{}}`))
	if err == nil {
		t.Fatal("a record was stamped with a clock nobody supplied")
	}
	if !strings.Contains(err.Error(), "clock") {
		t.Errorf("error = %v, want one naming the clock", err)
	}
}

// Reclaim cannot answer without being told how to ask whether a pid is alive:
// that question is a different one on every platform, and this package does not
// decide which one it is running on.
func TestReclaimWithNoLivenessAnswerRefusesByName(t *testing.T) {
	home := t.TempDir()
	kv, err := store.OpenKV(filepath.Join(home, "soksak.db"))
	if err != nil {
		t.Fatalf("opening: %v", err)
	}
	t.Cleanup(func() { _ = kv.Close() })
	registry := registered(t, store.Deps{KV: kv, Home: home, NowMillis: func() int64 { return 1 }, PID: 1})
	if _, err := registry.Invoke("data_reclaim", arguments(t, `{}`)); err == nil {
		t.Fatal("reclaim answered without knowing what alive means")
	}
}

// The default backup destination is resolved here and carried back, so the
// caller writes to the file that was actually written.
func TestBackupResolvesItsDefaultDestinationAndReturnsIt(t *testing.T) {
	registry, _, _ := wired(t)
	answer, err := registry.Invoke("data_backup", arguments(t, `{}`))
	if err != nil {
		t.Fatalf("backing up: %v", err)
	}
	result, ok := answer.(store.BackupResult)
	if !ok {
		t.Fatalf("answer = %#v", answer)
	}
	if !strings.Contains(result.Path, "backups") || !strings.Contains(result.Path, "1000") {
		t.Errorf("path = %q, want it under backups and stamped by the supplied clock", result.Path)
	}
}

// A missing required argument is refused by name rather than defaulted.
func TestAMissingRequiredArgumentIsRefusedByName(t *testing.T) {
	registry, _, _ := wired(t)
	for name, args := range map[string]string{
		"data_get":            `{"ns":"ui","coll":"t"}`,
		"data_put":            `{"ns":"ui","coll":"t"}`,
		"data_search":         `{"ns":"ui","coll":"t"}`,
		"data_migrate_ns":     `{"fromNs":"a"}`,
		"data_import":         `{}`,
		"data_restore":        `{}`,
		"data_retention_trim": `{"ns":"ui","coll":"t","scope":""}`,
		"plugin_data_write":   `{"id":"memo","key":"a"}`,
	} {
		if _, err := registry.Invoke(name, arguments(t, args)); err == nil {
			t.Errorf("%s accepted a call missing an argument", name)
		}
	}
}

// The answers that cross the boundary all encode, and none of them encodes to
// nothing. Measured (2026-08-08): one field that could not
// go to JSON did not drop that field — it made the whole answer `{}`, and the
// caller read the failure as success.
func TestEveryAnswerEncodes(t *testing.T) {
	registry, kv, _ := wired(t)
	if err := kv.Set("ui", "theme", `"Midnight"`); err != nil {
		t.Fatalf("writing: %v", err)
	}
	if _, err := registry.Invoke("data_put", arguments(t, `{"ns":"ui","coll":"t","id":"x","doc":{"n":1}}`)); err != nil {
		t.Fatalf("putting: %v", err)
	}
	for name, args := range map[string]string{
		"data_query":          `{"ns":"ui","coll":"t"}`,
		"data_count":          `{"ns":"ui","coll":"t"}`,
		"data_kv_keys":        `{"ns":"ui"}`,
		"data_kv_entries":     `{"ns":"ui"}`,
		"data_kv_delete_many": `{"ns":"ui","keys":["absent"]}`,
		"data_ns_remove":      `{"ns":"absent"}`,
		"data_migrate_ns":     `{"fromNs":"a","toNs":"b"}`,
		"data_export":         `{}`,
		"data_import":         `{"jsonl":""}`,
		"data_verify":         `{}`,
		"data_repair":         `{}`,
		"data_retention_reap": `{"ns":"ui","coll":"t","cutoffMs":1}`,
		"data_retention_trim": `{"ns":"ui","coll":"t","scope":"","cap":10}`,
		"plugin_data_list":    `{"id":"memo"}`,
	} {
		answer, err := registry.Invoke(name, arguments(t, args))
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		encoded, err := json.Marshal(answer)
		if err != nil {
			t.Errorf("%s answered something that cannot be encoded: %v", name, err)
			continue
		}
		if string(encoded) == "{}" && answer != nil {
			t.Errorf("%s encoded to an empty object: %#v", name, answer)
		}
	}
}

func mustEncode(t *testing.T, value any) []byte {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("encoding: %v", err)
	}
	return encoded
}

// Removing a namespace that held nothing publishes nothing. A change fact for
// something that did not happen sends every subscriber to re-read on the
// strength of a statement that was not true.
func TestRemovingAnEmptyNamespacePublishesNothing(t *testing.T) {
	registry, kv, published := wired(t)
	if err := kv.Set("plugin-real", "k", "1"); err != nil {
		t.Fatalf("writing: %v", err)
	}
	if _, err := registry.Invoke("data_ns_remove", arguments(t, `{"ns":"plugin-absent"}`)); err != nil {
		t.Fatalf("removing: %v", err)
	}
	if len(*published) != 0 {
		t.Errorf("published %v for a namespace that held nothing", *published)
	}
	if _, err := registry.Invoke("data_ns_remove", arguments(t, `{"ns":"plugin-real"}`)); err != nil {
		t.Fatalf("removing: %v", err)
	}
	if len(*published) != 1 {
		t.Fatalf("published %d changes for a namespace that held a key, want 1", len(*published))
	}
}

// A query nobody gave a direction to answers newest first. It is a default the
// caller never stated, so it is pinned here rather than left to be discovered
// by whoever reads a list the wrong way round.
func TestAQueryWithNoDirectionAnswersNewestFirst(t *testing.T) {
	registry, kv, _ := wired(t)
	for _, record := range []struct {
		id      string
		updated int64
	}{{"old", 10}, {"new", 20}} {
		if _, err := kv.Put("ui", "t", "", record.id,
			map[string]json.RawMessage{"n": json.RawMessage("1")}, record.updated); err != nil {
			t.Fatalf("putting: %v", err)
		}
	}
	answer, err := registry.Invoke("data_query", arguments(t, `{"ns":"ui","coll":"t"}`))
	if err != nil {
		t.Fatalf("querying: %v", err)
	}
	docs, ok := answer.([]json.RawMessage)
	if !ok || len(docs) != 2 {
		t.Fatalf("answer = %#v, want two records", answer)
	}
	if !strings.Contains(string(docs[0]), `"new"`) {
		t.Errorf("the first record is %s, want the one updated last", docs[0])
	}
}
