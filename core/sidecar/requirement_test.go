package sidecar

import (
	"encoding/json"
	"testing"
)

func TestRequirementAcceptsOnlyTheConsumerShape(t *testing.T) {
	var requirement Requirement
	if err := json.Unmarshal([]byte(`{"id":"soksak-spec-sidecar-pty","requirement":"0.0.1"}`), &requirement); err != nil {
		t.Fatal(err)
	}
	if requirement.ID != "soksak-spec-sidecar-pty" || requirement.Requirement != "0.0.1" {
		t.Fatalf("requirement=%+v", requirement)
	}
	for _, body := range []string{
		`{"id":"soksak-spec-sidecar-pty","version":"0.0.1"}`,
		`{"id":"soksak-spec-sidecar-pty","requirement":"*"}`,
		`{"id":"soksak-spec-sidecar-pty","requirement":"0.0.1","range":"0.0.1"}`,
		`{"id":"soksak-spec-sidecar-pty","requirement":"0.0.1"} {}`,
	} {
		if err := json.Unmarshal([]byte(body), &requirement); err == nil {
			t.Errorf("accepted %s", body)
		}
	}
}

func TestResolvedInterfaceSatisfiesConsumerRequirement(t *testing.T) {
	resolved := Resolved{InterfaceID: "soksak-spec-sidecar-pty", InterfaceVersion: "0.0.1"}
	for _, requirement := range []string{"0.0.1", "^0.0.1", ">=0.0.1 <0.0.2"} {
		if err := validateResolvedRequirement(resolved, "pty", Requirement{ID: resolved.InterfaceID, Requirement: requirement}); err != nil {
			t.Errorf("requirement %s: %v", requirement, err)
		}
	}
	if err := validateResolvedRequirement(resolved, "pty", Requirement{ID: resolved.InterfaceID, Requirement: "0.0.2"}); err == nil {
		t.Fatal("accepted a provider version outside the requirement")
	}
	if err := validateResolvedRequirement(resolved, "pty", Requirement{ID: "soksak-spec-sidecar-terminal", Requirement: "0.0.1"}); err == nil {
		t.Fatal("accepted a different interface id")
	}
}
