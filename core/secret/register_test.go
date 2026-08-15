package secret

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"testing"

	"github.com/soksak/soksak-core/core/control"
)

func args(t *testing.T, pairs map[string]any) control.Args {
	t.Helper()
	encoded := control.Args{}
	for key, value := range pairs {
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatalf("encoding %s: %v", key, err)
		}
		encoded[key] = raw
	}
	return encoded
}

func wired(t *testing.T) (*control.Registry, *Vault, *fakeKeyStore) {
	t.Helper()
	keys := workingKeyStore()
	registry := control.NewRegistry()
	vault := Register(registry, Deps{KV: openStore(t), KeyStore: keys})
	return registry, vault, keys
}

func describe(registry *control.Registry) (map[string]control.Owner, map[string]string) {
	served := map[string]control.Owner{}
	refused := map[string]string{}
	table := registry.Describe()
	for _, command := range table.Commands {
		served[command.Name] = command.Owner
	}
	for _, command := range table.Unserved {
		refused[command.Name] = command.BlockedBy
	}
	return served, refused
}

// Every name is host-independent, so `sok` reaches the vault with no window.
func TestTheVaultCommandsAreCoreOwned(t *testing.T) {
	registry, _, _ := wired(t)
	served, _ := describe(registry)

	for _, name := range commandNames {
		owner, present := served[name]
		if !present {
			t.Errorf("%s is not served", name)
			continue
		}
		if owner != control.OwnerCore {
			t.Errorf("%s is owned by %s; the vault needs no window", name, owner)
		}
	}
	if len(served) != len(commandNames) {
		t.Errorf("the group registered %d names and answers to %d", len(commandNames), len(served))
	}
}

// There is no read-back command. A get would put a plaintext on the same table
// as every other answer, and every transport that can print one would then be
// able to print a secret.
func TestTheVaultServesNoReadBack(t *testing.T) {
	registry, _, _ := wired(t)
	served, refused := describe(registry)
	for _, forbidden := range []string{"secret_get", "secret_read", "secret_value", "secret_export"} {
		if _, present := served[forbidden]; present {
			t.Errorf("%s is served; there is no plaintext read-back", forbidden)
		}
		if _, present := refused[forbidden]; present {
			t.Errorf("%s is declared; a read-back is not a command this build is missing", forbidden)
		}
	}
}

// A process with no store refuses all six by name. A vault with nowhere to
// write records is not one, and "unknown command" would leave the caller
// re-investigating settled ground.
func TestAProcessWithNoStoreRefusesEveryVaultCommand(t *testing.T) {
	registry := control.NewRegistry()
	Register(registry, Deps{KeyStore: workingKeyStore()})
	served, refused := describe(registry)

	if len(served) != 0 {
		t.Fatalf("a store-less process served %v", served)
	}
	for _, name := range commandNames {
		reason, declared := refused[name]
		if !declared {
			t.Errorf("%s was left unknown rather than declared", name)
			continue
		}
		if !strings.Contains(reason, "store") {
			t.Errorf("%s is refused because %q, which does not name the store", name, reason)
		}
	}
}

// A host that reached no key store cannot seal, and says exactly that. The
// other five still answer: what is stored can be listed, tested for and thrown
// away by a host that can no longer open it.
func TestAHostWithNoKeyStoreRefusesOnlySealing(t *testing.T) {
	registry := control.NewRegistry()
	Register(registry, Deps{KV: openStore(t)})
	served, refused := describe(registry)

	reason, declared := refused[commandSet]
	if !declared {
		t.Fatal("secret_set must be refused where nothing can seal it")
	}
	if !strings.Contains(reason, "key store") || !strings.Contains(reason, commandStatus) {
		t.Errorf("the refusal %q must name the key store and where to read the backend", reason)
	}
	for _, name := range commandNames {
		if name == commandSet {
			continue
		}
		if _, present := served[name]; !present {
			t.Errorf("%s stopped answering because this host cannot seal", name)
		}
	}

	// Invoking it carries the reason rather than "unknown command".
	_, err := registry.Invoke(commandSet, args(t, map[string]any{"ns": "core", "key": "token", "value": plaintext}))
	if err == nil || !strings.Contains(err.Error(), "key store") {
		t.Fatalf("invoking a refused secret_set answered %v", err)
	}
}

// The shapes the frontend calls with, through the registry the frontend
// reaches: set, then has, keys, delete, and has again.
func TestTheVaultAnswersTheShapesTheFrontendCallsWith(t *testing.T) {
	registry, _, _ := wired(t)
	call := func(name string, pairs map[string]any) any {
		t.Helper()
		answer, err := registry.Invoke(name, args(t, pairs))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		return answer
	}

	sealed := call(commandSet, map[string]any{"ns": "soksak-plugin-db-studio", "key": "anthropicKey", "value": plaintext}).(Sealed)
	if sealed.Replaced {
		t.Fatal("the first write reported that it replaced something")
	}
	again := call(commandSet, map[string]any{"ns": "soksak-plugin-db-studio", "key": "anthropicKey", "value": "second"}).(Sealed)
	if !again.Replaced {
		t.Fatal("the second write must say it overwrote the first")
	}

	if has := call(commandHas, map[string]any{"ns": "soksak-plugin-db-studio", "key": "anthropicKey"}).(bool); !has {
		t.Fatal("secret_has must answer true for a key that was written")
	}
	if has := call(commandHas, map[string]any{"ns": "soksak-plugin-db-studio", "key": "absent"}).(bool); has {
		t.Fatal("secret_has must answer false for a key that was not written")
	}

	keys := call(commandKeys, map[string]any{"ns": "soksak-plugin-db-studio"}).([]string)
	if fmt.Sprint(keys) != "[anthropicKey]" {
		t.Fatalf("secret_keys answered %v", keys)
	}

	if removed := call(commandDelete, map[string]any{"ns": "soksak-plugin-db-studio", "key": "anthropicKey"}).(bool); !removed {
		t.Fatal("secret_delete must say it removed a key that was there")
	}
	if removed := call(commandDelete, map[string]any{"ns": "soksak-plugin-db-studio", "key": "anthropicKey"}).(bool); removed {
		t.Fatal("secret_delete must say it removed nothing the second time")
	}
	if has := call(commandHas, map[string]any{"ns": "soksak-plugin-db-studio", "key": "anthropicKey"}).(bool); has {
		t.Fatal("a deleted key is still in the vault")
	}
}

// A namespace nothing was written to is an empty list, never null: "this
// namespace holds nothing" and "this build cannot tell you" must not arrive as
// the same answer.
func TestAnEmptyNamespaceListsAsAnEmptyList(t *testing.T) {
	registry, _, _ := wired(t)
	answer, err := registry.Invoke(commandKeys, args(t, map[string]any{"ns": "core"}))
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(answer)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != "[]" {
		t.Fatalf("an empty namespace listed as %s", encoded)
	}
}

// One namespace never lists another's keys, including one it is a prefix of.
func TestOneNamespaceNeverListsAnothersKeys(t *testing.T) {
	registry, _, _ := wired(t)
	for _, ns := range []string{"a", "ab"} {
		if _, err := registry.Invoke(commandSet, args(t, map[string]any{"ns": ns, "key": ns + "key", "value": plaintext})); err != nil {
			t.Fatal(err)
		}
	}
	for ns, want := range map[string]string{"a": "[akey]", "ab": "[abkey]"} {
		answer, err := registry.Invoke(commandKeys, args(t, map[string]any{"ns": ns}))
		if err != nil {
			t.Fatal(err)
		}
		keys := answer.([]string)
		sort.Strings(keys)
		if fmt.Sprint(keys) != want {
			t.Errorf("namespace %s listed %v, want %s", ns, keys, want)
		}
	}
}

// A missing argument is named. A caller that receives a zero value cannot tell
// it from one it sent, and an empty key would seal a value where nobody looks.
func TestAMissingArgumentIsRefusedByName(t *testing.T) {
	registry, _, _ := wired(t)
	for name, pairs := range map[string]map[string]any{
		commandSet:    {"ns": "core", "key": "token"},
		commandHas:    {"ns": "core"},
		commandKeys:   {},
		commandDelete: {"key": "token"},
	} {
		_, err := registry.Invoke(name, args(t, pairs))
		if err == nil {
			t.Errorf("%s accepted %v", name, pairs)
			continue
		}
		if !strings.Contains(err.Error(), "missing argument") {
			t.Errorf("%s answered %v", name, err)
		}
	}
}

// The key store is asked once. A transparent unlock that happened per command
// would turn one prompt into one for every call the settings panel makes.
func TestTheKeyStoreIsAskedOnce(t *testing.T) {
	registry, _, keys := wired(t)
	for range 3 {
		if _, err := registry.Invoke(commandStatus, control.Args{}); err != nil {
			t.Fatal(err)
		}
		if _, err := registry.Invoke(commandSet, args(t, map[string]any{"ns": "core", "key": "token", "value": plaintext})); err != nil {
			t.Fatal(err)
		}
	}
	if keys.asked != 1 {
		t.Fatalf("the key store was asked %d times", keys.asked)
	}
}

// A key store that was unreachable is asked again. Caching the refusal would
// outlive the reason for it: a session bus that came back would still be
// reported as absent until the application restarted.
func TestAnUnreachableKeyStoreIsAskedAgain(t *testing.T) {
	keys := &fakeKeyStore{label: "test-keychain", err: errors.New("no session bus")}
	vault := newVault(Deps{KV: openStore(t), KeyStore: keys})

	if vault.Status().SealAvailable {
		t.Fatal("a key store that failed must not report that sealing works")
	}
	keys.err, keys.key = nil, deviceKeyOf(0x40)
	if !vault.Status().SealAvailable {
		t.Fatal("a key store that came back is still reported as absent")
	}
	if keys.asked != 2 {
		t.Fatalf("the key store was asked %d times", keys.asked)
	}
}
