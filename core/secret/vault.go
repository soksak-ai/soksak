// Package secret is this application's vault.
//
// It seals a value under a device key the operating system holds, and hands the
// plaintext to exactly one caller: a child process's environment, through
// process.SecretSource. There is no read-back command and no read-back method.
// A get is a leak with a caller attached — every log line, error and activity
// entry downstream of one would carry the value — so injection into a child is
// the only way a plaintext leaves here.
//
// Nothing in this package reads the environment, the platform, or the clock.
// The store, the key store, and what app.data registered all arrive as values,
// which is what lets one vault answer identically in a window, in a headless
// server, and in a test.
package secret

import (
	"fmt"
	"sync"

	"github.com/soksak/soksak-core/core/i18n"
	"github.com/soksak/soksak-core/core/process"
	"github.com/soksak/soksak-core/core/store"
)

// Deps is what the surrounding process supplies. Every field is something this
// package could have discovered for itself and deliberately does not.
type Deps struct {
	// KV is the open store. Storage is core/store's; this package owns the
	// shape of a record and nothing about where records live.
	//
	// Nil is a process with nowhere to write, which is not a vault: every
	// command below is refused by name rather than answering as if it had one.
	KV *store.KV
	// KeyStore is the operating system's key store, holding this device's key.
	//
	// Nil is a host that reached none. Sealing is then impossible: secret_set
	// is refused by name and secret_status reports seal_available false. It is
	// never a plaintext fallback — a value written unprotected would be read
	// back as though it had been sealed.
	KeyStore KeyStore
	// DataKeyIDs answers which envelope keys app.data has registered. That
	// ledger is the storage group's, not this one's, so it arrives as a
	// function rather than being read out of a namespace this package would
	// then own the layout of.
	//
	// Nil answers none, which is the truth in a build where app.data is not
	// sealed.
	DataKeyIDs func() []string
}

// KeyStore is the operating system's key store — Keychain, Credential Manager,
// libsecret.
//
// It is an interface because which one exists is a fact about the host, and
// this package answers the same way whichever it is. The unlock is transparent:
// there is no passphrase command, so the only question a caller may ask is
// whether the store could be reached.
type KeyStore interface {
	// Label names the backend for a caller to read: a fact to report, never a
	// value to branch on. Empty is not a name and gives a caller nothing.
	Label() string
	// DeviceKey answers this device's 32-byte key, creating it on first ask.
	//
	// An error from here is shown to a caller, so it states why the store could
	// not be opened and never contains the key.
	DeviceKey() ([]byte, error)
}

// The vault is the SecretSource the process group declares. Asserted here
// because satisfying that interface is why this package exists, and a signature
// that drifts apart from it would only be found by a spawn failing.
var _ process.SecretSource = (*Vault)(nil)

// Vault seals and opens this process's secrets.
type Vault struct {
	deps Deps

	mu sync.Mutex
	// device is cached after the first successful read. The unlock is meant to
	// happen once: asking the operating system's key store on every call turns
	// one prompt into one per command. A failure is never cached — a key store
	// that was unreachable a minute ago may be reachable now, and a cached
	// refusal would outlive the reason for it.
	device material
}

func newVault(deps Deps) *Vault { return &Vault{deps: deps} }

// deviceKey answers this host's device key, reading it once.
func (vault *Vault) deviceKey() (material, error) {
	vault.mu.Lock()
	defer vault.mu.Unlock()

	if !vault.device.empty() {
		return vault.device, nil
	}
	if vault.deps.KeyStore == nil {
		return material{}, i18n.Errorf("secret.deviceKey.noKeyStore", nil)
	}
	bytes, err := vault.deps.KeyStore.DeviceKey()
	if err != nil {
		return material{}, fmt.Errorf("secret: the %s key store could not be reached: %w", vault.backendLabel(), err)
	}
	if len(bytes) != deviceKeySize {
		// The length is named, never the key. A key store that answers with the
		// wrong size is a host bug, and a caller cannot fix what it cannot see.
		return material{}, i18n.Errorf("secret.deviceKey.wrongSize", map[string]string{
			"backend":  vault.backendLabel(),
			"size":     fmt.Sprint(len(bytes)),
			"required": fmt.Sprint(deviceKeySize),
		})
	}
	vault.device = material{bytes: bytes}
	return vault.device, nil
}

func (vault *Vault) backendLabel() string {
	if vault.deps.KeyStore == nil {
		return noKeyStore
	}
	return vault.deps.KeyStore.Label()
}

func (vault *Vault) storage() (*store.KV, error) {
	if vault.deps.KV == nil {
		return nil, i18n.Errorf("secret.deps.noStore", nil)
	}
	return vault.deps.KV, nil
}

// Sealed is what a write answers.
//
// Replaced is here because a null answer reads the same whether a key was
// created or an existing one was overwritten, and a caller that meant to create
// has no other way to find out it did not.
type Sealed struct {
	Ns       string `json:"ns"`
	Key      string `json:"key"`
	Replaced bool   `json:"replaced"`
}

// Set seals one value at ns/key, replacing whatever was there.
//
// The plaintext is a parameter and never becomes part of an answer or an error:
// every failure below names the address and the reason, and nothing else.
func (vault *Vault) Set(ns, key, plaintext string) (Sealed, error) {
	kv, err := vault.storage()
	if err != nil {
		return Sealed{}, err
	}
	row, err := address(ns, key)
	if err != nil {
		return Sealed{}, err
	}
	device, err := vault.deviceKey()
	if err != nil {
		return Sealed{}, err
	}

	_, replaced, err := kv.Get(vaultNamespace, row)
	if err != nil {
		return Sealed{}, err
	}
	record, err := seal(device, ns, key, []byte(plaintext))
	if err != nil {
		return Sealed{}, err
	}
	encoded, err := encodeRecord(record)
	if err != nil {
		return Sealed{}, err
	}
	if err := kv.Set(vaultNamespace, row, encoded); err != nil {
		return Sealed{}, err
	}
	return Sealed{Ns: ns, Key: key, Replaced: replaced}, nil
}

// Has reports whether ns/key is in the vault, without opening it. A key that is
// stored can be answered for even on a host that can no longer unseal it.
func (vault *Vault) Has(ns, key string) (bool, error) {
	kv, err := vault.storage()
	if err != nil {
		return false, err
	}
	row, err := address(ns, key)
	if err != nil {
		return false, err
	}
	_, found, err := kv.Get(vaultNamespace, row)
	return found, err
}

// Keys lists the key names stored under a namespace, sorted.
//
// Names, never values. A namespace nothing was written to is an empty list
// rather than a failure — the first audit of every namespace would otherwise be
// an error.
func (vault *Vault) Keys(ns string) ([]string, error) {
	kv, err := vault.storage()
	if err != nil {
		return nil, err
	}
	prefix, err := namespacePrefix(ns)
	if err != nil {
		return nil, err
	}
	rows, err := kv.Keys(vaultNamespace, &prefix)
	if err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(rows))
	for _, row := range rows {
		keys = append(keys, row[len(prefix):])
	}
	return keys, nil
}

// Delete removes ns/key and reports whether it was there. It needs no device key:
// a host that can no longer unseal a record must still be able to throw it
// away.
func (vault *Vault) Delete(ns, key string) (bool, error) {
	kv, err := vault.storage()
	if err != nil {
		return false, err
	}
	row, err := address(ns, key)
	if err != nil {
		return false, err
	}
	return kv.DeleteKey(vaultNamespace, row)
}

// Resolve opens one secret for injection into a child's environment. It is the
// implementation of process.SecretSource, and the only plaintext path out of
// this package.
//
// An absent key and an unopenable one are separate answers: the first is a
// caller naming something that was never stored, the second is this host being
// unable to read what is.
func (vault *Vault) Resolve(ns, key string) (string, error) {
	kv, err := vault.storage()
	if err != nil {
		return "", err
	}
	row, err := address(ns, key)
	if err != nil {
		return "", err
	}
	device, err := vault.deviceKey()
	if err != nil {
		return "", err
	}
	stored, found, err := kv.Get(vaultNamespace, row)
	if err != nil {
		return "", err
	}
	if !found {
		return "", i18n.Errorf("secret.get.notFound", map[string]string{"ns": ns, "key": key})
	}
	record, err := decodeRecord(ns, key, stored)
	if err != nil {
		return "", err
	}
	plaintext, err := open(device, ns, key, record)
	if err != nil {
		return "", err
	}
	return string(plaintext), nil
}
