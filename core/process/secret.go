package process

import (
	"sort"

	"github.com/soksak/soksak-core/core/i18n"
)

// SecretSource resolves one namespaced key to plaintext. The implementation
// is the vault holder's.
//
// Resolution is a contract rather than a concrete vault handle because a
// spawn needs a vault only when it requires a secret. Wiring the vault into
// the spawn itself would tie "start a child" to "this process has a vault".
type SecretSource interface {
	Resolve(namespace, key string) (string, error)
}

// noVault is the answer of a host that holds no vault. It declares that fact
// rather than handing back an empty value: an empty token makes the child's
// authentication failure look like a misconfiguration, and the real reason —
// this process has no vault — is then recorded nowhere.
type noVault struct{}

func (noVault) Resolve(namespace, key string) (string, error) {
	return "", i18n.Errorf("process.secret.noVault", map[string]string{"ns": namespace, "key": key})
}

// resolveSecretEnv turns a secretEnv map (environment name → secret key) into
// plaintext pairs, before anything is spawned.
//
// Empty means empty: the vault is never asked. Non-empty requires a namespace,
// and if one key fails they all do — a child that starts half-configured
// reports its failure as anything but a secret problem.
//
// The plaintext returned here goes into the child's environment and nowhere
// else. A caller that hands it back as a value has leaked it.
func resolveSecretEnv(source SecretSource, namespace string, secretEnv map[string]string) ([][2]string, error) {
	if len(secretEnv) == 0 {
		return nil, nil
	}
	if namespace == "" {
		return nil, i18n.Errorf("process.secret.needsNamespace", nil)
	}
	if source == nil {
		source = noVault{}
	}

	names := make([]string, 0, len(secretEnv))
	for name := range secretEnv {
		names = append(names, name)
	}
	// Sorted for determinism: a failure that names a different key on each run
	// makes the diagnosis move.
	sort.Strings(names)

	resolved := make([][2]string, 0, len(names))
	for _, name := range names {
		plaintext, err := source.Resolve(namespace, secretEnv[name])
		if err != nil {
			return nil, err
		}
		resolved = append(resolved, [2]string{name, plaintext})
	}
	return resolved, nil
}
