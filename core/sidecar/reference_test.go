package sidecar

import (
	"encoding/json"
	"testing"
)

// sidecar_open receives the manifest's dependency intent: id and version, nothing else.
func TestSidecarOpenReceivesADependencyReference(t *testing.T) {
	var value DependencyReference
	if err := json.Unmarshal([]byte(`{"id":"fixture-pty-provider","version":"0.0.6"}`), &value); err != nil {
		t.Fatal(err)
	}
	if value != (DependencyReference{ID: "fixture-pty-provider", Version: "0.0.6"}) {
		t.Fatalf("reference=%+v", value)
	}
	encoded, err := json.Marshal(value)
	if err != nil || string(encoded) != `{"id":"fixture-pty-provider","version":"0.0.6"}` {
		t.Fatalf("encoded=%s err=%v", encoded, err)
	}
}
