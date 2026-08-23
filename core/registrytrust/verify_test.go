package registrytrust

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"testing"
	"time"

	registry "github.com/soksak-ai/soksak-contract-registry"
)

func TestVerifyUsesNativeEd25519AndContinuity(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	document := registry.SignedRegistry{
		Registry: registry.Registry{ID: "official", Sequence: 7, Plugins: []registry.PluginRelease{}, Sidecars: []registry.SidecarRelease{}, Kits: []registry.KitRelease{}, Contracts: []registry.ContractRelease{}, Specs: []registry.SpecRelease{}},
		IssuedAt: "2026-08-23T00:00:00Z", ExpiresAt: "2026-08-24T00:00:00Z", Algorithm: "ed25519", KeyID: "key",
	}
	if err := registry.Sign(&document, private); err != nil {
		t.Fatal(err)
	}
	receipt, err := Verify(document, Trust{RegistryID: "official", KeyID: "key", PublicKey: base64.StdEncoding.EncodeToString(public)}, time.Date(2026, 8, 23, 12, 0, 0, 0, time.UTC), nil)
	if err != nil || receipt.Sequence != 7 || receipt.Continuity != "initial" {
		t.Fatalf("receipt=%+v err=%v", receipt, err)
	}
	if _, err := Verify(document, Trust{RegistryID: "official", KeyID: "key", PublicKey: base64.StdEncoding.EncodeToString(public)}, time.Date(2026, 8, 23, 12, 0, 0, 0, time.UTC), &HighWater{Sequence: 8, Digest: receipt.Digest}); err == nil {
		t.Fatal("registry rollback was accepted")
	}
}
