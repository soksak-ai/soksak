package sidecar

import (
	"encoding/json"
	"testing"
)

// sidecar_open receives the manifest's dependency intent: id and version, nothing else.
func TestSidecarOpenReceivesADependencyReference(t *testing.T) {
	var value DependencyReference
	if err := json.Unmarshal([]byte(`{"id":"soksak-sidecar-pty","version":"0.0.6"}`), &value); err != nil {
		t.Fatal(err)
	}
	if value != (DependencyReference{ID: "soksak-sidecar-pty", Version: "0.0.6"}) {
		t.Fatalf("reference=%+v", value)
	}
	encoded, err := json.Marshal(value)
	if err != nil || string(encoded) != `{"id":"soksak-sidecar-pty","version":"0.0.6"}` {
		t.Fatalf("encoded=%s err=%v", encoded, err)
	}
}
