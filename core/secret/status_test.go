package secret

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// A host with no key store states that, by name rather than by
// an empty string a reader would take for "did not answer".
func TestAHostWithNoKeyStoreNamesTheAbsence(t *testing.T) {
	vault := newVault(Deps{KV: openStore(t)})
	status := vault.Status()
	if status.Backend != noKeyStore {
		t.Fatalf("the backend of a host with no key store is %q", status.Backend)
	}
	if status.SealAvailable {
		t.Fatal("a host with no key store reported that sealing works")
	}
	// A no-secret-service host is never a plaintext fallback.
	if _, err := vault.Set("core", "token", plaintext); err == nil {
		t.Fatal("a host with no key store stored a value anyway")
	}
}

// A key store that cannot be reached is reported as unavailable while its name
// is still carried: the operator has to know which one failed.
func TestAnUnreachableKeyStoreIsStillNamed(t *testing.T) {
	keys := &fakeKeyStore{label: "libsecret", err: errors.New("no session bus")}
	status := newVault(Deps{KV: openStore(t), KeyStore: keys}).Status()
	if status.Backend != "libsecret" {
		t.Fatalf("the backend is %q", status.Backend)
	}
	if status.SealAvailable {
		t.Fatal("a key store that failed reported that sealing works")
	}
}

// A key store that answers with the wrong size is a host bug, and the refusal
// names the size — never the key it was given.
func TestAWrongSizedDeviceKeyIsRefusedByItsSize(t *testing.T) {
	short := []byte("0123456789")
	vault := newVault(Deps{KV: openStore(t), KeyStore: &fakeKeyStore{label: "wincred", key: short}})
	_, err := vault.Set("core", "token", plaintext)
	if err == nil {
		t.Fatal("a 10-byte device key was accepted")
	}
	if !strings.Contains(err.Error(), "10-byte") {
		t.Fatalf("error %q must name the size it was given", err)
	}
	if strings.Contains(err.Error(), string(short)) {
		t.Fatalf("error %q carries the key it was given", err)
	}
}

// The envelope keys app.data registered belong to the storage group. Nil is
// none, and none is an empty list rather than null.
func TestNoRegisteredDataKeysIsAnEmptyList(t *testing.T) {
	status := newVault(Deps{KV: openStore(t), KeyStore: workingKeyStore()}).Status()
	if status.ExpectVault {
		t.Fatal("a build with no registered envelope keys expects a vault")
	}
	encoded, err := json.Marshal(status)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"data_key_ids":[]`) {
		t.Fatalf("the status encoded as %s", encoded)
	}
}

// Once app.data registers envelope keys, the status includes them and reports a
// vault is expected.
func TestRegisteredDataKeysAreCarried(t *testing.T) {
	vault := newVault(Deps{
		KV:         openStore(t),
		KeyStore:   workingKeyStore(),
		DataKeyIDs: func() []string { return []string{"k-1", "k-2"} },
	})
	status := vault.Status()
	if !status.ExpectVault {
		t.Fatal("registered envelope keys must make a vault expected")
	}
	if strings.Join(status.DataKeyIDs, ",") != "k-1,k-2" {
		t.Fatalf("the status carries %v", status.DataKeyIDs)
	}
}

// The two names answer from one measurement. Two of them could disagree, and
// then a plugin is told it may store a secret while the settings panel is told
// it may not.
func TestBackendAndStatusCannotDisagree(t *testing.T) {
	for _, keys := range []*fakeKeyStore{
		workingKeyStore(),
		{label: "libsecret", err: errors.New("no session bus")},
	} {
		vault := newVault(Deps{KV: openStore(t), KeyStore: keys})
		status, backend := vault.Status(), vault.Backend()
		if backend.Backend != status.Backend || backend.Unlocked != status.SealAvailable {
			t.Fatalf("secret_backend answered %+v while secret_status answered %+v", backend, status)
		}
	}
}

// The status is the same whether the vault holds a hundred secrets or none.
// A status that moved with the contents would be a side channel.
func TestTheStatusDoesNotMoveWithTheContents(t *testing.T) {
	vault, _, _ := workingVault(t)
	before, err := json.Marshal(vault.Status())
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"one", "two", "three"} {
		if _, err := vault.Set("core", key, plaintext); err != nil {
			t.Fatal(err)
		}
	}
	after, err := json.Marshal(vault.Status())
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatalf("the status went from %s to %s", before, after)
	}
}
