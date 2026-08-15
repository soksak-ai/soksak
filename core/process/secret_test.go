package process

import (
	"fmt"
	"strings"
	"testing"
)

type recordingVault struct {
	asked   [][2]string
	missing bool
}

func (vault *recordingVault) Resolve(namespace, key string) (string, error) {
	vault.asked = append(vault.asked, [2]string{namespace, key})
	if vault.missing {
		return "", fmt.Errorf("no secret named %s", key)
	}
	return "plain-" + key, nil
}

// A spawn that needs no secret never opens the vault. If it did, a host without
// one could start nothing at all.
func TestASpawnWithoutSecretsNeverAsksTheVault(t *testing.T) {
	vault := &recordingVault{}
	for _, secretEnv := range []map[string]string{nil, {}} {
		resolved, err := resolveSecretEnv(vault, "", secretEnv)
		if err != nil {
			t.Fatalf("%v: %v", secretEnv, err)
		}
		if len(resolved) != 0 {
			t.Fatalf("%v resolved to %v", secretEnv, resolved)
		}
	}
	if len(vault.asked) != 0 {
		t.Fatalf("the vault was asked %v", vault.asked)
	}
}

// Resolution order is sorted, so a failure always names the same key for the
// same request and a diagnosis does not move between runs.
func TestEveryNamedSecretResolvesInOrder(t *testing.T) {
	vault := &recordingVault{}
	resolved, err := resolveSecretEnv(vault, "plug", map[string]string{"B": "k2", "A": "k1"})
	if err != nil {
		t.Fatal(err)
	}
	want := [][2]string{{"A", "plain-k1"}, {"B", "plain-k2"}}
	if fmt.Sprint(resolved) != fmt.Sprint(want) {
		t.Fatalf("resolved %v, want %v", resolved, want)
	}
}

// One missing secret fails the whole spawn. A half-configured child reports
// its authentication failure as anything but a secret problem.
func TestOneMissingSecretFailsTheWholeSpawn(t *testing.T) {
	vault := &recordingVault{missing: true}
	_, err := resolveSecretEnv(vault, "plug", map[string]string{"A": "k1"})
	if err == nil {
		t.Fatal("a missing secret must fail the spawn")
	}
	if !strings.Contains(err.Error(), "k1") {
		t.Fatalf("error %q must name the key that could not be resolved", err)
	}
}

// Secrets are namespaced. Without a namespace there is nothing to scope the
// lookup to, and a plugin could read another's key.
func TestSecretsWithoutANamespaceAreRefused(t *testing.T) {
	vault := &recordingVault{}
	_, err := resolveSecretEnv(vault, "", map[string]string{"A": "k1"})
	if err == nil {
		t.Fatal("secret injection without a namespace must be refused")
	}
	if !strings.Contains(err.Error(), "ns") {
		t.Fatalf("error %q must name the missing argument", err)
	}
	if len(vault.asked) != 0 {
		t.Fatal("the vault must not be asked once the request is already refused")
	}
}

// A host with no vault states that. An empty value would let the child attach with
// an empty token and report the authentication failure as a misconfiguration,
// leaving the real reason nowhere.
func TestAHostWithoutAVaultSaysSo(t *testing.T) {
	_, err := resolveSecretEnv(noVault{}, "plug", map[string]string{"A": "k1"})
	if err == nil {
		t.Fatal("a vault-less host must refuse rather than hand over an empty value")
	}
	if !strings.Contains(err.Error(), "vault") {
		t.Fatalf("error %q must say this process has no vault", err)
	}
	if !strings.Contains(err.Error(), "plug/k1") {
		t.Fatalf("error %q must say what it could not do", err)
	}
	// With no secrets asked for, a vault-less host resolves fine.
	resolved, err := resolveSecretEnv(noVault{}, "", nil)
	if err != nil || len(resolved) != 0 {
		t.Fatalf("a vault-less host with no secrets: %v, %v", resolved, err)
	}
}
