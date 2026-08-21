package secret

import (
	"fmt"
	"path/filepath"
	"testing"

	"github.com/soksak-ai/soksak-core/core/store"
)

// What every test in this package needs: a real store and a key store whose
// answer the test fixes.
//
// The store is the real one rather than a stand-in. The rule under test is that
// a plaintext never enters storage, and a fake store would let this package's
// own idea of what it wrote stand in for what a caller can actually read back.

// fakeKeyStore is one host's key store, with the answer the test chooses.
type fakeKeyStore struct {
	label string
	key   []byte
	err   error
	asked int
}

func (keys *fakeKeyStore) Label() string { return keys.label }

func (keys *fakeKeyStore) DeviceKey() ([]byte, error) {
	keys.asked++
	if keys.err != nil {
		return nil, keys.err
	}
	return keys.key, nil
}

// deviceKeyOf makes a 32-byte key that is distinctive enough for a leak check
// to find it if it ever escapes.
func deviceKeyOf(seed byte) []byte {
	key := make([]byte, deviceKeySize)
	for index := range key {
		key[index] = seed + byte(index)
	}
	return key
}

func workingKeyStore() *fakeKeyStore {
	return &fakeKeyStore{label: "test-keychain", key: deviceKeyOf(0x40)}
}

func openStore(t *testing.T) *store.KV {
	t.Helper()
	kv, err := store.OpenKV(filepath.Join(t.TempDir(), "soksak.db"))
	if err != nil {
		t.Fatalf("opening the store: %v", err)
	}
	t.Cleanup(func() { _ = kv.Close() })
	return kv
}

// workingVault is a vault that can seal, over a store only this test can see.
func workingVault(t *testing.T) (*Vault, *store.KV, *fakeKeyStore) {
	t.Helper()
	kv, keys := openStore(t), workingKeyStore()
	return newVault(Deps{KV: kv, KeyStore: keys}), kv, keys
}

// storedRecord reads the row a secret was written to, exactly as anything else
// with the store handle would see it.
func storedRecord(t *testing.T, kv *store.KV, ns, key string) string {
	t.Helper()
	row, err := address(ns, key)
	if err != nil {
		t.Fatalf("addressing %s/%s: %v", ns, key, err)
	}
	value, found, err := kv.Get(vaultNamespace, row)
	if err != nil {
		t.Fatalf("reading %s/%s: %v", ns, key, err)
	}
	if !found {
		t.Fatalf("%s/%s was not written", ns, key)
	}
	return value
}

// everyVerb renders a value the way a log line, a panic, or a %v in an error
// would. A redaction that only covers %v is not one.
func everyVerb(value any) string {
	rendered := ""
	for _, format := range []string{"%v", "%+v", "%#v", "%s", "%q", "%d", "%x", "%X"} {
		rendered += fmt.Sprintf(format, value) + "\n"
	}
	return rendered
}
