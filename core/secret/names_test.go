package secret

import (
	"strings"
	"testing"
)

// The separator is the whole isolation rule, so nothing that could carry one
// may pass. A namespace that could hold `/` would let a plugin address another
// plugin's row by spelling it, and no later check would see anything wrong.
func TestNoHalfOfAnAddressCanCarryTheSeparator(t *testing.T) {
	for _, ns := range []string{"a/b", "..", ".", "a b", "A", "-a", "", "a.b", "a:b"} {
		if err := validateNamespace(ns); err == nil {
			t.Errorf("namespace %q was accepted", ns)
		}
	}
	for _, key := range []string{"a/b", ".", "..", "a b", "", "a:b", "a\x00b"} {
		if err := validateKey(key); err == nil {
			t.Errorf("key %q was accepted", key)
		}
	}
}

// The names a caller actually uses: a plugin id and a core namespace, and the
// key spellings the plugin API documents.
func TestTheNamesCallersUseAreAccepted(t *testing.T) {
	for _, ns := range []string{"core", "soksak-plugin-db-studio", "a", "a1"} {
		if err := validateNamespace(ns); err != nil {
			t.Errorf("namespace %q: %v", ns, err)
		}
	}
	for _, key := range []string{"anthropicKey", "api-token", "api_token", "v1.token", "A1"} {
		if err := validateKey(key); err != nil {
			t.Errorf("key %q: %v", key, err)
		}
	}
}

// A namespace never reaches into a namespace that starts with its own letters.
//
// The prefix ends in the separator, so `a`'s scan cannot pick up `ab`'s rows.
// Without the separator in the prefix this is a cross-plugin read of what keys
// another plugin holds.
func TestOneNamespaceNeverPrefixesAnother(t *testing.T) {
	short, err := namespacePrefix("a")
	if err != nil {
		t.Fatal(err)
	}
	long, err := namespacePrefix("ab")
	if err != nil {
		t.Fatal(err)
	}
	row, err := address("ab", "k")
	if err != nil {
		t.Fatal(err)
	}
	if strings.HasPrefix(row, short) {
		t.Fatalf("%q starts with %q; namespace a would list namespace ab's keys", row, short)
	}
	if !strings.HasPrefix(row, long) {
		t.Fatalf("%q does not start with %q", row, long)
	}
}

// A refused name is refused before anything is stored, and the refusal says
// which name it was about.
func TestARefusedAddressNamesTheHalfThatFailed(t *testing.T) {
	if _, err := address("Core", "k"); err == nil || !strings.Contains(err.Error(), "Core") {
		t.Fatalf("error %v must name the namespace", err)
	}
	if _, err := address("core", "k/j"); err == nil || !strings.Contains(err.Error(), "k/j") {
		t.Fatalf("error %v must name the key", err)
	}
}
