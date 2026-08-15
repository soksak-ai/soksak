package secret

import (
	"encoding/hex"
	"encoding/json"
	"strconv"
	"strings"
	"testing"
)

// Key material prints as a label under every verb there is.
//
// %v is the one a reviewer thinks of. %d and %x are the ones that actually
// print bytes, and a Stringer does not cover them.
func TestKeyMaterialPrintsAsALabelUnderEveryVerb(t *testing.T) {
	held := material{bytes: deviceKeyOf(0x40)}
	rendered := everyVerb(held)
	for _, byteValue := range held.bytes {
		if strings.Contains(rendered, hex.EncodeToString([]byte{byteValue, byteValue + 1})) {
			t.Fatalf("the rendering carries the key bytes:\n%s", rendered)
		}
	}
	// The first two bytes as decimal, which is what %d of a byte slice writes.
	pair := strconv.Itoa(int(held.bytes[0])) + " " + strconv.Itoa(int(held.bytes[1]))
	if strings.Contains(rendered, pair) {
		t.Fatalf("the rendering carries the key bytes:\n%s", rendered)
	}
	if strings.Count(rendered, redacted) != strings.Count(rendered, "\n") {
		t.Fatalf("some verb rendered something other than the label:\n%s", rendered)
	}
}

// The other way out is JSON, which does not consult a Formatter. A struct that
// ever carries key material into an answer must not be able to encode it.
func TestKeyMaterialEncodesAsALabel(t *testing.T) {
	encoded, err := json.Marshal(material{bytes: deviceKeyOf(0x40)})
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != strconv.Quote(redacted) {
		t.Fatalf("marshalled as %s", encoded)
	}
}

// The vault prints as a vault.
//
// fmt cannot call a method on an unexported field, so it reflects into the
// cached device key and writes the bytes. The redaction has to sit on the value
// a host actually holds, which is the one Register hands back.
func TestTheVaultPrintsAsAVault(t *testing.T) {
	vault, _, keys := workingVault(t)
	if _, err := vault.Set("core", "token", plaintext); err != nil {
		t.Fatal(err)
	}
	rendered := everyVerb(vault)
	for _, forbidden := range []string{
		plaintext,
		hex.EncodeToString(keys.key),
		strconv.Itoa(int(keys.key[0])) + " " + strconv.Itoa(int(keys.key[1])),
	} {
		if strings.Contains(rendered, forbidden) {
			t.Fatalf("printing the vault carried %q:\n%s", forbidden, rendered)
		}
	}
	if !strings.Contains(rendered, redacted) {
		t.Fatalf("printing the vault said nothing about being redacted:\n%s", rendered)
	}
}
