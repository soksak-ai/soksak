package secret

import (
	"strings"
	"testing"
)

const plaintext = "sk-ant-PLAINTEXT-CANARY-0123456789"

func device(t *testing.T, seed byte) material {
	t.Helper()
	return material{bytes: deviceKeyOf(seed)}
}

// The round trip, which is the only thing the two layers exist to do.
func TestASealedValueOpensAtTheAddressItWasSealedAt(t *testing.T) {
	key := device(t, 0x40)
	record, err := seal(key, "core", "token", []byte(plaintext))
	if err != nil {
		t.Fatal(err)
	}
	opened, err := open(key, "core", "token", record)
	if err != nil {
		t.Fatal(err)
	}
	if string(opened) != plaintext {
		t.Fatalf("opened %q", opened)
	}
}

// A record is bound to its address, so a row copied to another ns/key does not
// open there.
//
// Whoever can write to the store can already destroy a record. What must stay
// impossible is making one key answer with another key's value: a plugin that
// could copy `core/token` to its own namespace would read the core's secret
// through an injection it is allowed to ask for.
func TestARecordMovedToAnotherAddressDoesNotOpen(t *testing.T) {
	key := device(t, 0x40)
	record, err := seal(key, "core", "token", []byte(plaintext))
	if err != nil {
		t.Fatal(err)
	}
	for _, moved := range [][2]string{
		{"soksak-plugin-thief", "token"},
		{"core", "other"},
	} {
		opened, err := open(key, moved[0], moved[1], record)
		if err == nil {
			t.Fatalf("%s/%s opened a record sealed elsewhere: %q", moved[0], moved[1], opened)
		}
		if strings.Contains(err.Error(), plaintext) {
			t.Fatalf("the refusal carries the value: %v", err)
		}
	}
}

// A record sealed on another device is refused by name. Without the key id the
// same failure reads as a corrupted row, and the operator looks for damage
// instead of for the key that is missing.
func TestARecordFromAnotherDeviceNamesBothKeys(t *testing.T) {
	sealer, reader := device(t, 0x40), device(t, 0x90)
	record, err := seal(sealer, "core", "token", []byte(plaintext))
	if err != nil {
		t.Fatal(err)
	}
	_, err = open(reader, "core", "token", record)
	if err == nil {
		t.Fatal("a record sealed under another device key must not open")
	}
	if !strings.Contains(err.Error(), deviceKeyID(sealer)) || !strings.Contains(err.Error(), deviceKeyID(reader)) {
		t.Fatalf("error %q must name the key it was sealed under and the one this host holds", err)
	}
}

// A version this build does not write is one it does not read. There is no
// migration path here; the refusal names both versions so the reader has
// which side is old.
func TestAnotherFormatVersionIsRefusedByName(t *testing.T) {
	key := device(t, 0x40)
	record, err := seal(key, "core", "token", []byte(plaintext))
	if err != nil {
		t.Fatal(err)
	}
	record.Version = envelopeVersion + 1
	_, err = open(key, "core", "token", record)
	if err == nil {
		t.Fatal("a record from another format version must be refused")
	}
	if !strings.Contains(err.Error(), "version") {
		t.Fatalf("error %q must name the format version", err)
	}
}

// Two seals of one value share nothing. Equal ciphertext would tell anyone who
// can read the store which two namespaces hold the same token.
func TestSealingTheSameValueTwiceSharesNothing(t *testing.T) {
	key := device(t, 0x40)
	first, err := seal(key, "core", "token", []byte(plaintext))
	if err != nil {
		t.Fatal(err)
	}
	second, err := seal(key, "core", "token", []byte(plaintext))
	if err != nil {
		t.Fatal(err)
	}
	if first.Value == second.Value {
		t.Fatal("two seals of one value produced the same ciphertext")
	}
	if first.DataKey == second.DataKey {
		t.Fatal("two seals of one value share a data key")
	}
	if first.DeviceKeyID != second.DeviceKeyID {
		t.Fatal("one device key produced two ids")
	}
}

// A damaged record is a failure, never an empty value. An empty answer would
// reach the child as an empty token, and the authentication failure that
// follows would be recorded as the child's problem.
func TestADamagedRecordFailsRatherThanOpeningEmpty(t *testing.T) {
	key := device(t, 0x40)
	record, err := seal(key, "core", "token", []byte(plaintext))
	if err != nil {
		t.Fatal(err)
	}
	for name, damaged := range map[string]envelope{
		"value not base64":   {Version: envelopeVersion, DeviceKeyID: deviceKeyID(key), DataKey: record.DataKey, Value: "not base64!"},
		"value truncated":    {Version: envelopeVersion, DeviceKeyID: deviceKeyID(key), DataKey: record.DataKey, Value: "AAAA"},
		"data key truncated": {Version: envelopeVersion, DeviceKeyID: deviceKeyID(key), DataKey: "AAAA", Value: record.Value},
		"data key swapped":   {Version: envelopeVersion, DeviceKeyID: deviceKeyID(key), DataKey: record.Value, Value: record.Value},
	} {
		opened, err := open(key, "core", "token", damaged)
		if err == nil {
			t.Errorf("%s opened as %q", name, opened)
		}
	}
}
