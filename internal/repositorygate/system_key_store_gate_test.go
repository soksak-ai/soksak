package repositorygate

import (
	"os"
	"strings"
	"testing"
)

func TestSystemKeyStoreUsesTheExistingKeyringDependency(t *testing.T) {
	body, err := os.ReadFile("internal/application/system_key_store.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(body)
	if !strings.Contains(source, "set: keyring.Set") {
		t.Fatal("system key writes do not use the existing keyring dependency")
	}
	for _, path := range []string{"internal/application/system_key_store_darwin.go", "internal/application/system_key_store_other.go"} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("platform keyring reimplementation remains: %s", path)
		}
	}
	for _, forbidden := range []string{"/usr/bin/security", "exec.Command", "write timed out"} {
		if strings.Contains(source, forbidden) {
			t.Fatalf("system key store reimplements %q", forbidden)
		}
	}
}
