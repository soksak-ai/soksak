package main

import (
	"bytes"
	"encoding/base64"
	"testing"

	keyring "github.com/zalando/go-keyring"
)

func TestSystemKeyStoreCreatesReusesAndValidatesDeviceKey(t *testing.T) {
	keyring.MockInit()
	store := &systemKeyStore{
		service: "com.soksak.test.vault", label: "test-keyring", set: keyring.Set,
	}
	first, err := store.DeviceKey()
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.DeviceKey()
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != deviceKeySize || !bytes.Equal(first, second) {
		t.Fatal("device key was not reused")
	}
	if err := keyring.Set(store.service, deviceKeyAccount, "not-base64"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.DeviceKey(); err == nil {
		t.Fatal("corrupt device key was accepted")
	}
	if err := keyring.Set(store.service, deviceKeyAccount, base64.StdEncoding.EncodeToString([]byte("short"))); err != nil {
		t.Fatal(err)
	}
	if _, err := store.DeviceKey(); err == nil {
		t.Fatal("short device key was accepted")
	}
}
