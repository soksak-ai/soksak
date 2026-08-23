package sidecar

import (
	"encoding/json"
	"testing"
)

func TestSidecarOpenUsesTheCommonReleaseReference(t *testing.T) {
	var value ReleaseReference
	if err := json.Unmarshal([]byte(`{"id":"soksak-sidecar-pty","version":"0.0.6","url":"https://github.com/soksak-ai/soksak-sidecar-pty/releases/download/v0.0.6/release.json","size":123,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`), &value); err != nil {
		t.Fatal(err)
	}
	if value.ID != "soksak-sidecar-pty" || value.Version != "0.0.6" {
		t.Fatalf("reference=%+v", value)
	}
}
