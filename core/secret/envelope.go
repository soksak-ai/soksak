package secret

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"

	"github.com/soksak-ai/soksak-core/core/i18n"
)

// The envelope rule: a per-record data key seals the value, and the device key
// seals the data key.
//
// Two layers rather than one so the device key can be replaced by re-wrapping
// each data key, and no plaintext value has to be read back out to do it. A
// single layer would make rotation and read-back the same operation, and this
// package has no read-back.
//
// Both layers are bound to the address the record was sealed at. A row copied
// from one ns/key to another therefore fails its tag before any plaintext
// exists: whoever can write to the store can destroy a record, and must not be
// able to make one key answer with another key's value.

const (
	envelopeVersion = 1
	deviceKeySize   = 32
	dataKeySize     = 32
)

// envelope is one stored record. Every field is ciphertext or a label; the
// struct is safe to print, which is why the key material is not in it.
type envelope struct {
	Version int `json:"v"`
	// DeviceKeyID names which device key wrapped the data key. Without it, a
	// record sealed on another device fails as "authentication failed" and the
	// caller cannot tell that from a corrupted row.
	DeviceKeyID string `json:"kek"`
	DataKey     string `json:"dek"`
	Value       string `json:"ct"`
}

// deviceKeyID is a one-way label for a 256-bit key, so a record can name the
// key that sealed it without carrying anything that helps open it.
func deviceKeyID(device material) string {
	sum := sha256.Sum256(append([]byte("soksak/secret/device-key-id/v1\x00"), device.bytes...))
	return hex.EncodeToString(sum[:8])
}

// boundTo is the additional data both layers authenticate. It holds the
// version so a later format cannot be opened as this one.
func boundTo(ns, key string) []byte {
	return fmt.Appendf(nil, "soksak/secret/v%d\x00%s\x00%s", envelopeVersion, ns, key)
}

func sealBytes(with material, bound, plaintext []byte) (string, error) {
	block, err := aes.NewCipher(with.bytes)
	if err != nil {
		return "", fmt.Errorf("secret: the key is not usable: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("secret: the cipher is not usable: %w", err)
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", fmt.Errorf("secret: the system random source failed: %w", err)
	}
	return base64.StdEncoding.EncodeToString(aead.Seal(nonce, nonce, plaintext, bound)), nil
}

func openBytes(with material, bound []byte, encoded string) ([]byte, error) {
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, i18n.Errorf("secret.record.notBase64", nil)
	}
	block, err := aes.NewCipher(with.bytes)
	if err != nil {
		return nil, fmt.Errorf("secret: the key is not usable: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("secret: the cipher is not usable: %w", err)
	}
	if len(raw) < aead.NonceSize() {
		return nil, i18n.Errorf("secret.record.noNonce", map[string]string{"bytes": fmt.Sprint(len(raw))})
	}
	plaintext, err := aead.Open(nil, raw[:aead.NonceSize()], raw[aead.NonceSize():], bound)
	if err != nil {
		// The cipher's own message is not passed on. It states nothing a caller
		// can act on, and the two facts that matter are named here instead.
		return nil, i18n.Errorf("secret.record.wrongKeyOrAddress", nil)
	}
	return plaintext, nil
}

// seal wraps one value for one address.
func seal(device material, ns, key string, plaintext []byte) (envelope, error) {
	dataKey := material{bytes: make([]byte, dataKeySize)}
	if _, err := rand.Read(dataKey.bytes); err != nil {
		return envelope{}, fmt.Errorf("secret: the system random source failed: %w", err)
	}

	bound := boundTo(ns, key)
	wrapped, err := sealBytes(device, bound, dataKey.bytes)
	if err != nil {
		return envelope{}, err
	}
	value, err := sealBytes(dataKey, bound, plaintext)
	if err != nil {
		return envelope{}, err
	}
	return envelope{
		Version:     envelopeVersion,
		DeviceKeyID: deviceKeyID(device),
		DataKey:     wrapped,
		Value:       value,
	}, nil
}

// open unwraps one record for the address it is being read at.
func open(device material, ns, key string, record envelope) ([]byte, error) {
	// A record from another format is refused rather than guessed at. There is
	// no migration here: a version this build does not write is one it does not
	// read.
	if record.Version != envelopeVersion {
		return nil, i18n.Errorf("secret.record.otherVersion", map[string]string{
			"ns": ns, "key": key,
			"version": fmt.Sprint(record.Version), "writes": fmt.Sprint(envelopeVersion)})
	}
	if held := deviceKeyID(device); record.DeviceKeyID != held {
		return nil, i18n.Errorf("secret.record.otherDevice", map[string]string{
			"ns": ns, "key": key, "sealed": record.DeviceKeyID, "held": held})
	}

	bound := boundTo(ns, key)
	dataKey, err := openBytes(device, bound, record.DataKey)
	if err != nil {
		return nil, fmt.Errorf("secret: the data key of %s/%s could not be unwrapped: %w", ns, key, err)
	}
	plaintext, err := openBytes(material{bytes: dataKey}, bound, record.Value)
	if err != nil {
		return nil, fmt.Errorf("secret: the value of %s/%s could not be opened: %w", ns, key, err)
	}
	return plaintext, nil
}

func encodeRecord(record envelope) (string, error) {
	encoded, err := json.Marshal(record)
	if err != nil {
		return "", fmt.Errorf("secret: the record could not be encoded: %w", err)
	}
	return string(encoded), nil
}

func decodeRecord(ns, key, stored string) (envelope, error) {
	var record envelope
	if err := json.Unmarshal([]byte(stored), &record); err != nil {
		return record, i18n.Errorf("secret.record.notSealed", map[string]string{"ns": ns, "key": key})
	}
	return record, nil
}
