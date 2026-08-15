package store

import (
	"encoding/json"
	"testing"
)

// An axis an operation has no value for is carried as null, never dropped. Drop
// the key and "absent" and "not sent" become the same on the receiving side —
// one is normal and one is a defect.
func TestAnAbsentAxisIsCarriedAsNull(t *testing.T) {
	encoded, err := json.Marshal(Change{Ns: "core", Op: OpKVSet, ID: stringPointer("settings")})
	if err != nil {
		t.Fatalf("encoding: %v", err)
	}
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("decoding: %v", err)
	}
	for _, axis := range []string{"ns", "coll", "scope", "op", "id"} {
		if _, present := decoded[axis]; !present {
			t.Errorf("axis %q is missing from %s", axis, encoded)
		}
	}
	if string(decoded["coll"]) != "null" || string(decoded["scope"]) != "null" {
		t.Errorf("an absent axis is not null: %s", encoded)
	}
}

// A change nobody can pin names the whole store, so a subscriber re-reads
// everything rather than re-reading the wrong key.
func TestAChangeThatCannotBePinnedNamesTheWholeStore(t *testing.T) {
	if WholeStore != "*" {
		t.Errorf("WholeStore = %q", WholeStore)
	}
}

// The operation names are constants because more than one process publishes
// them. Measured (2026-08-01): the app sent `kv_set` and the
// daemon sent `kv-set`. Nobody had broken yet, but the first subscriber to look
// at `op` would behave differently depending on who answered.
func TestTheOperationNamesAreFixed(t *testing.T) {
	for name, want := range map[string]string{
		OpKVSet: "kv_set", OpKVDelete: "kv_delete", OpNsRemove: "ns_remove",
		OpPut: "put", OpDelete: "delete", OpReap: "reap", OpTrim: "trim",
		OpImport: "import", OpRestore: "restore",
	} {
		if name != want {
			t.Errorf("operation %q, want %q", name, want)
		}
	}
}
