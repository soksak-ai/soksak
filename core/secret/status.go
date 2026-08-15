package secret

// What a caller may know about the vault without holding a secret.
//
// The backend's name, whether sealing works, and which envelope keys app.data
// registered. None of it is derived from a stored value, so the status of a
// vault holding a hundred secrets reads the same as one holding none.

// noKeyStore is the backend name of a host that reached none. It is a name
// rather than an empty string so a caller reading the status can tell "this
// host has no key store" from "this host did not say".
const noKeyStore = "none"

// Status is the whole answer to secret_status.
type Status struct {
	Backend string `json:"backend"`
	// SealAvailable is whether the key store answered. It is measured by
	// asking, because a flag the host set at start-up is stale the moment the
	// session bus goes away, and a caller acting on a stale yes writes nothing
	// and is told it worked.
	SealAvailable bool `json:"seal_available"`
	// ExpectVault is whether app.data has envelope keys registered. A build
	// where storage is not sealed registers none, and none is the answer.
	ExpectVault bool     `json:"expect_vault"`
	DataKeyIDs  []string `json:"data_key_ids"`
}

// Backend is the narrower answer the plugin API requests by that name.
//
// It is projected from Status rather than measured a second time: two
// measurements of "can this host seal" can disagree, and then one command
// reports to a plugin that it may store a secret while the other reports to the
// settings panel that it
// may not.
type Backend struct {
	Backend  string `json:"backend"`
	Unlocked bool   `json:"unlocked"`
}

// Status reads the vault's condition. Reaching the key store is part of the
// question, so this is where the transparent unlock happens for a caller that
// has not stored anything yet.
func (vault *Vault) Status() Status {
	// A list, never null: "no envelope keys are registered" and "this build
	// cannot tell you" must not arrive as the same answer.
	registered := []string{}
	if vault.deps.DataKeyIDs != nil {
		registered = append(registered, vault.deps.DataKeyIDs()...)
	}
	_, err := vault.deviceKey()
	return Status{
		Backend:       vault.backendLabel(),
		SealAvailable: err == nil,
		ExpectVault:   len(registered) > 0,
		DataKeyIDs:    registered,
	}
}

// Backend answers the same measurement under the older, narrower shape.
func (vault *Vault) Backend() Backend {
	status := vault.Status()
	return Backend{Backend: status.Backend, Unlocked: status.SealAvailable}
}
