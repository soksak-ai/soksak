package main

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"

	"github.com/soksak-ai/soksak-core/core/i18n"
	"github.com/soksak-ai/soksak-core/core/secret"
	keyring "github.com/zalando/go-keyring"
)

const deviceKeyAccount = "device-key-v1"
const deviceKeySize = 32

type systemKeyStore struct {
	service, label string
	set            func(service, account, value string) error
}

func newSystemKeyStore(identifier, label string) secret.KeyStore {
	return &systemKeyStore{service: identifier + ".vault", label: label, set: setSystemKey}
}

func (store *systemKeyStore) Label() string { return store.label }

func (store *systemKeyStore) DeviceKey() ([]byte, error) {
	encoded, err := keyring.Get(store.service, deviceKeyAccount)
	if err == nil {
		key, decodeErr := base64.StdEncoding.DecodeString(encoded)
		if decodeErr != nil {
			return nil, i18n.Errorf("secret.deviceKey.notBase64", map[string]string{"backend": store.label})
		}
		if len(key) != deviceKeySize {
			return nil, i18n.Errorf("secret.deviceKey.wrongSize", map[string]string{
				"backend": store.label, "size": fmt.Sprint(len(key)), "required": fmt.Sprint(deviceKeySize),
			})
		}
		return key, nil
	}
	if !errors.Is(err, keyring.ErrNotFound) {
		return nil, err
	}
	key := make([]byte, deviceKeySize)
	if _, err := rand.Read(key); err != nil {
		return nil, fmt.Errorf("generate device key: %w", err)
	}
	if err := store.set(store.service, deviceKeyAccount, base64.StdEncoding.EncodeToString(key)); err != nil {
		return nil, err
	}
	return key, nil
}

func keyStoreLabel(goos string) string {
	switch goos {
	case "darwin":
		return "keychain"
	case "windows":
		return "credential-manager"
	case "linux":
		return "secret-service"
	default:
		return "system-key-store"
	}
}
