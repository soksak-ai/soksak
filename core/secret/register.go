package secret

import (
	"github.com/soksak/soksak-core/core/control"
)

// The command boundary for the vault.
//
// Six names, all host-independent: none of them needs a window, so `sok` and a
// button reach the same entries. There is deliberately no seventh — a get would
// put a plaintext on the same table as everything else, and every transport
// that can print an answer would then be able to print a secret.

const (
	commandSet      = "secret_set"
	commandGenerate = "secret_generate"
	commandHas      = "secret_has"
	commandKeys     = "secret_keys"
	commandDelete   = "secret_delete"
	commandStatus   = "secret_status"
	commandBackend  = "secret_backend"
)

// commandNames is every name this group answers to, in the order a reader meets
// them: write, read-about, remove, then the two that describe the vault itself.
var commandNames = []string{
	commandSet, commandGenerate, commandHas, commandKeys, commandDelete,
	commandStatus, commandBackend,
}

// Register wires the vault's commands and answers with the vault itself.
//
// The vault comes back because these six are not its only caller:
// process.Deps.Secrets needs this instance. A host that built a second one from
// the same Deps would hold a second device-key cache, and the operating
// system's key store would be asked — and on some hosts prompt — twice.
func Register(registry *control.Registry, deps Deps) *Vault {
	vault := newVault(deps)

	if deps.KV == nil {
		// Declared rather than left unknown. A caller that hears only "unknown
		// command" cannot tell a vault this build refuses to run from one it
		// forgot to write.
		declareAll(registry, commandNames,
			"this process holds no store, and a vault with nowhere to write records is not one")
		return vault
	}

	if deps.KeyStore == nil {
		// Sealing is the one thing a host with no key store cannot do. The rest
		// still answers: what is stored can be listed, tested for and thrown
		// away on a host that can no longer open it, and secret_status is how a
		// caller finds out why writing is refused.
		declareAll(registry, []string{commandSet, commandGenerate},
			"this host was given no key store, so a value cannot be sealed; secret_status names the backend it holds")
	} else {
		registry.MustRegister(control.Command{
			Name:  commandSet,
			Owner: control.OwnerCore,
			Handler: func(arguments control.Args) (any, error) {
				ns, err := control.Arg[string](arguments, "ns")
				if err != nil {
					return nil, err
				}
				key, err := control.Arg[string](arguments, "key")
				if err != nil {
					return nil, err
				}
				value, err := control.Arg[string](arguments, "value")
				if err != nil {
					return nil, err
				}
				return vault.Set(ns, key, value)
			},
		})
		registry.MustRegister(control.Command{
			Name: commandGenerate, Owner: control.OwnerCore,
			Handler: func(arguments control.Args) (any, error) {
				ns, err := control.Arg[string](arguments, "ns")
				if err != nil {
					return nil, err
				}
				key, err := control.Arg[string](arguments, "key")
				if err != nil {
					return nil, err
				}
				size, err := control.Arg[int](arguments, "bytes")
				if err != nil {
					return nil, err
				}
				return vault.Generate(ns, key, size)
			},
		})
	}

	registry.MustRegister(control.Command{
		Name:  commandHas,
		Owner: control.OwnerCore,
		Handler: func(arguments control.Args) (any, error) {
			ns, err := control.Arg[string](arguments, "ns")
			if err != nil {
				return nil, err
			}
			key, err := control.Arg[string](arguments, "key")
			if err != nil {
				return nil, err
			}
			return vault.Has(ns, key)
		},
	})

	registry.MustRegister(control.Command{
		Name:  commandKeys,
		Owner: control.OwnerCore,
		Handler: func(arguments control.Args) (any, error) {
			ns, err := control.Arg[string](arguments, "ns")
			if err != nil {
				return nil, err
			}
			return vault.Keys(ns)
		},
	})

	registry.MustRegister(control.Command{
		Name:  commandDelete,
		Owner: control.OwnerCore,
		Handler: func(arguments control.Args) (any, error) {
			ns, err := control.Arg[string](arguments, "ns")
			if err != nil {
				return nil, err
			}
			key, err := control.Arg[string](arguments, "key")
			if err != nil {
				return nil, err
			}
			return vault.Delete(ns, key)
		},
	})

	registry.MustRegister(control.Command{
		Name:    commandStatus,
		Owner:   control.OwnerCore,
		Handler: func(control.Args) (any, error) { return vault.Status(), nil },
	})

	registry.MustRegister(control.Command{
		Name:    commandBackend,
		Owner:   control.OwnerCore,
		Handler: func(control.Args) (any, error) { return vault.Backend(), nil },
	})

	return vault
}

func declareAll(registry *control.Registry, names []string, because string) {
	for _, name := range names {
		if err := registry.DeclareUnserved(name, because); err != nil {
			// A refusal that cannot be recorded is a boot-time programming
			// fact, not a runtime condition.
			panic(err)
		}
	}
}
