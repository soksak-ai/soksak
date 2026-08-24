package application

import (
	"bytes"
	"encoding/json"
	"testing"

	"github.com/soksak-ai/soksak-core/core/identity"
)

func TestControlReadinessAnnouncementBindsSocketIdentityAndProcess(t *testing.T) {
	var output bytes.Buffer
	resolved := identity.Resolved{Socket: "<local-evidence>/soksak-ready.sock", Identifier: "com.soksak.ready"}
	if err := announceControlReady(&output, resolved, 42); err != nil {
		t.Fatal(err)
	}
	var event struct {
		Event      string `json:"event"`
		Protocol   int    `json:"protocol"`
		Socket     string `json:"socket"`
		Identifier string `json:"identifier"`
		PID        int    `json:"pid"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(output.Bytes()), &event); err != nil {
		t.Fatal(err)
	}
	if event.Event != "soksak.control.ready" || event.Protocol != 1 ||
		event.Socket != resolved.Socket || event.Identifier != resolved.Identifier || event.PID != 42 {
		t.Fatalf("readiness event=%+v", event)
	}
}

func TestHostReadinessAnnouncementUsesTheSameOwnedIdentity(t *testing.T) {
	var output bytes.Buffer
	resolved := identity.Resolved{Socket: "<local-evidence>/soksak-ready.sock", Identifier: "com.soksak.ready"}
	if err := announceHostReady(&output, resolved, 42); err != nil {
		t.Fatal(err)
	}
	var event controlReadyEvent
	if err := json.Unmarshal(bytes.TrimSpace(output.Bytes()), &event); err != nil {
		t.Fatal(err)
	}
	if event.Event != "soksak.host.ready" || event.Protocol != 1 || event.Socket != resolved.Socket ||
		event.Identifier != resolved.Identifier || event.PID != 42 {
		t.Fatalf("readiness event=%+v", event)
	}
}
