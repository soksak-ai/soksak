//go:build darwin

package main

import (
	"testing"

	"github.com/soksak-ai/soksak-core/core/i18n"
)

func TestKeychainWriteConfirmsThePasswordThroughStdin(t *testing.T) {
	input, err := keychainPasswordInput("service", "account", "value")
	if err != nil {
		t.Fatal(err)
	}
	if input != "value\nvalue\n" {
		t.Fatalf("keychain password input = %q", input)
	}
}

func TestKeychainWriteRejectsCommandSeparators(t *testing.T) {
	_, err := keychainPasswordInput("service", "account", "value\nsecond")
	if err == nil {
		t.Fatal("newline was accepted in a keychain command field")
	}
	carried, ok := err.(*i18n.Error)
	if !ok || carried.Key != "systemKeyStore.invalidField" {
		t.Fatalf("invalid keychain field error = %#v", err)
	}
}
