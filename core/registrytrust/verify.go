package registrytrust

import (
	"crypto/ed25519"
	"encoding/base64"
	"time"

	registry "github.com/soksak-ai/soksak-contract-registry"
	"github.com/soksak-ai/soksak-core/core/i18n"
)

type Trust struct {
	RegistryID string `json:"registryId"`
	KeyID      string `json:"keyId"`
	PublicKey  string `json:"publicKey"`
}

type HighWater = registry.HighWater
type Receipt = registry.Verification

func Verify(document registry.SignedRegistry, trust Trust, now time.Time, highWater *HighWater) (Receipt, error) {
	publicKey, err := base64.StdEncoding.DecodeString(trust.PublicKey)
	if err != nil || len(publicKey) != ed25519.PublicKeySize {
		return Receipt{}, i18n.Errorf("registrytrust.publicKeyInvalid", nil)
	}
	return registry.Verify(document, registry.Trust{RegistryID: trust.RegistryID, KeyID: trust.KeyID, PublicKey: ed25519.PublicKey(publicKey)}, now, highWater)
}
