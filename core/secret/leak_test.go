package secret

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The rule this package exists for: a value written to a log line, an error,
// an answer, or a stored row is a leaked value.
//
// Injection into a child's environment is the one path out, and it is
// Resolve's. Everything else may name the address and the reason and nothing
// more, because every one of those surfaces is somewhere a caller can print.

// mentionsThePlaintext reports where a rendering contains the value.
func mentionsThePlaintext(rendered string) bool {
	return strings.Contains(rendered, plaintext)
}

// A secret never enters the database. The store is the real one, so this reads
// what anything else holding the handle would read.
func TestAStoredSecretIsNotInTheDatabase(t *testing.T) {
	vault, kv, _ := workingVault(t)
	if _, err := vault.Set("core", "token", plaintext); err != nil {
		t.Fatal(err)
	}

	record := storedRecord(t, kv, "core", "token")
	if mentionsThePlaintext(record) {
		t.Fatalf("the stored record carries the value: %s", record)
	}

	// The row is one place; the file is the other. A journal or a write-ahead
	// log that held the value would leak it to anyone who can read the home.
	directory := filepath.Dir(kv.Path())
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		bytes, err := os.ReadFile(filepath.Join(directory, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if mentionsThePlaintext(string(bytes)) {
			t.Fatalf("%s carries the value", entry.Name())
		}
	}
}

// No command's answer contains the value — not the write that was handed it,
// not the listing, not the status.
func TestNoCommandAnswerCarriesTheValue(t *testing.T) {
	registry, _, _ := wired(t)
	if _, err := registry.Invoke(commandSet, args(t, map[string]any{"ns": "core", "key": "token", "value": plaintext})); err != nil {
		t.Fatal(err)
	}

	for _, call := range []struct {
		name  string
		pairs map[string]any
	}{
		{commandSet, map[string]any{"ns": "core", "key": "token", "value": plaintext}},
		{commandHas, map[string]any{"ns": "core", "key": "token"}},
		{commandKeys, map[string]any{"ns": "core"}},
		{commandStatus, map[string]any{}},
		{commandBackend, map[string]any{}},
		{commandDelete, map[string]any{"ns": "core", "key": "token"}},
	} {
		answer, err := registry.Invoke(call.name, args(t, call.pairs))
		if err != nil {
			t.Fatalf("%s: %v", call.name, err)
		}
		encoded, err := json.Marshal(answer)
		if err != nil {
			t.Fatalf("%s: %v", call.name, err)
		}
		if mentionsThePlaintext(string(encoded)) {
			t.Errorf("%s answered %s", call.name, encoded)
		}
		// %v of an answer is what a log line writes, and it is not the same
		// rendering as JSON.
		if mentionsThePlaintext(everyVerb(answer)) {
			t.Errorf("%s renders as %v", call.name, answer)
		}
	}
}

// No refusal contains the value. Every one of these is a path that was handed a
// plaintext and had to fail; an error is printed far more often than an answer.
func TestNoRefusalCarriesTheValue(t *testing.T) {
	kv := openStore(t)

	sealed, _, _ := workingVault(t)
	if _, err := sealed.Set("core", "token", plaintext); err != nil {
		t.Fatal(err)
	}
	damaged, damagedKV, _ := workingVault(t)
	if _, err := damaged.Set("core", "token", plaintext); err != nil {
		t.Fatal(err)
	}
	row, err := address("core", "token")
	if err != nil {
		t.Fatal(err)
	}
	if err := damagedKV.Set(vaultNamespace, row, `{"v":1,"kek":"deadbeefdeadbeef","dek":"AAAA","ct":"AAAA"}`); err != nil {
		t.Fatal(err)
	}

	refusals := map[string]error{}
	record := func(name string, err error) {
		if err == nil {
			t.Fatalf("%s did not refuse", name)
		}
		refusals[name] = err
	}

	// A namespace and a key that are not names, holding a value that is.
	_, err = sealed.Set("Core", "token", plaintext)
	record("a namespace that is not a name", err)
	_, err = sealed.Set("core", "to/ken", plaintext)
	record("a key that is not a name", err)

	// A host that cannot seal, holding a value that has to go somewhere.
	_, err = newVault(Deps{KV: kv}).Set("core", "token", plaintext)
	record("no key store", err)
	_, err = newVault(Deps{KV: kv, KeyStore: &fakeKeyStore{label: "libsecret", err: errors.New("no session bus")}}).Set("core", "token", plaintext)
	record("an unreachable key store", err)
	_, err = newVault(Deps{KV: kv, KeyStore: &fakeKeyStore{label: "wincred", key: []byte("short")}}).Set("core", "token", plaintext)
	record("a wrong-sized device key", err)
	_, err = newVault(Deps{}).Set("core", "token", plaintext)
	record("no store", err)

	// The read side: a record this host cannot open, and one that is not there.
	_, err = damaged.Resolve("core", "token")
	record("a damaged record", err)
	_, err = sealed.Resolve("core", "absent")
	record("an absent record", err)
	_, err = newVault(Deps{KV: kv, KeyStore: workingKeyStore()}).Resolve("core", "token")
	record("a record in another store", err)

	for name, err := range refusals {
		if mentionsThePlaintext(err.Error()) {
			t.Errorf("%s refused with %q", name, err)
		}
		if mentionsThePlaintext(everyVerb(err)) {
			t.Errorf("%s renders as %v", name, err)
		}
	}
}

// Injection is the one path out, and it works. Without this, everything above
// is satisfied by a vault that stores nothing anyone can ever use.
func TestInjectionIsTheOnePathOut(t *testing.T) {
	vault, _, _ := workingVault(t)
	if _, err := vault.Set("soksak-plugin-db-studio", "anthropicKey", plaintext); err != nil {
		t.Fatal(err)
	}
	opened, err := vault.Resolve("soksak-plugin-db-studio", "anthropicKey")
	if err != nil {
		t.Fatal(err)
	}
	if opened != plaintext {
		t.Fatalf("the child would be given %q", opened)
	}
}

// One namespace cannot open another's secret, which is what makes the ns
// argument an isolation boundary rather than a label.
func TestOneNamespaceCannotOpenAnothersSecret(t *testing.T) {
	vault, _, _ := workingVault(t)
	if _, err := vault.Set("core", "token", plaintext); err != nil {
		t.Fatal(err)
	}
	opened, err := vault.Resolve("soksak-plugin-thief", "token")
	if err == nil {
		t.Fatalf("another namespace opened it as %q", opened)
	}
	if mentionsThePlaintext(err.Error()) {
		t.Fatalf("the refusal carries the value: %v", err)
	}
}

// An absent secret and an unopenable one are separate answers. Folding them
// together sends the operator looking for a key they never stored, or for
// damage that is not there.
func TestAbsenceAndFailureAreSeparateAnswers(t *testing.T) {
	vault, kv, _ := workingVault(t)
	if _, err := vault.Set("core", "token", plaintext); err != nil {
		t.Fatal(err)
	}
	absent, err := vault.Resolve("core", "never-stored")
	if err == nil {
		t.Fatalf("an absent key resolved to %q", absent)
	}
	if !strings.Contains(err.Error(), "not in this vault") {
		t.Fatalf("an absent key answered %q", err)
	}

	row, err := address("core", "token")
	if err != nil {
		t.Fatal(err)
	}
	if err := kv.Set(vaultNamespace, row, `{"v":1,"kek":"deadbeefdeadbeef","dek":"AAAA","ct":"AAAA"}`); err != nil {
		t.Fatal(err)
	}
	_, err = vault.Resolve("core", "token")
	if err == nil {
		t.Fatal("a record this host cannot open resolved anyway")
	}
	if strings.Contains(err.Error(), "not in this vault") {
		t.Fatalf("an unopenable record answered as absent: %q", err)
	}
}

// The vault satisfies the interface a spawn resolves through, and answers it
// the way that spawn expects: plaintext for the child, error by name otherwise.
func TestTheVaultIsWhatASpawnResolvesThrough(t *testing.T) {
	vault, _, _ := workingVault(t)
	if _, err := vault.Set("core", "token", plaintext); err != nil {
		t.Fatal(err)
	}
	var source interface {
		Resolve(namespace, key string) (string, error)
	} = vault
	opened, err := source.Resolve("core", "token")
	if err != nil || opened != plaintext {
		t.Fatalf("resolved %q, %v", opened, err)
	}
	if _, err := source.Resolve("core", "absent"); err == nil {
		t.Fatal("a missing secret must fail the spawn")
	} else if !strings.Contains(err.Error(), "core/absent") {
		t.Fatalf("error %q must name what could not be resolved", err)
	}
}

// Registering the group must not make a caller able to print a secret through
// the table itself. Describe is what `sok` reads before it calls anything.
func TestTheCommandTableCarriesNoValue(t *testing.T) {
	registry, _, _ := wired(t)
	if _, err := registry.Invoke(commandSet, args(t, map[string]any{"ns": "core", "key": "token", "value": plaintext})); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(registry.Describe())
	if err != nil {
		t.Fatal(err)
	}
	if mentionsThePlaintext(string(encoded)) {
		t.Fatalf("the command table carries the value: %s", encoded)
	}
}
