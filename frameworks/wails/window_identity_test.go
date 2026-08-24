package wails

import "testing"

func TestWindowURLCarriesItsExactApplicationIdentity(t *testing.T) {
	got := windowIdentityURL("/?root=%2Fwork", "com.soksak.gate.123")
	want := "/?identity=com.soksak.gate.123&root=%2Fwork"
	if got != want {
		t.Fatalf("window URL = %q, want %q", got, want)
	}
}
