package sidecar

import (
	"encoding/json"
	"testing"

	"github.com/soksak-ai/soksak-core/core/control"
)

func TestStatusPublishesSelectedProcessWithoutSecrets(t *testing.T) {
	host := NewHost(Deps{})
	host.open["terminal"] = &unit{
		open:        Open{Name: "terminal", PID: 42, Version: "0.0.42"},
		path:        "/installed/terminal/dist/project-sidecar-terminal",
		token:       "private-token",
		secretNames: "private-names",
		stderr:      newRing(4),
	}

	registry := control.NewRegistry()
	Register(registry, Registration{
		Host:    host,
		Resolve: func(Consumer, DependencyReference) (Resolved, error) { return Resolved{}, nil },
	})
	answer, err := registry.Invoke("sidecar_status", control.Args{})
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(answer)
	if err != nil {
		t.Fatal(err)
	}
	var status struct {
		Open []struct {
			Name        string `json:"name"`
			Version     string `json:"version"`
			Process     string `json:"process"`
			PID         int    `json:"pid"`
			Token       string `json:"token"`
			SecretNames string `json:"secretNames"`
		} `json:"open"`
	}
	if err := json.Unmarshal(encoded, &status); err != nil {
		t.Fatal(err)
	}
	if len(status.Open) != 1 {
		t.Fatalf("open=%+v", status.Open)
	}
	got := status.Open[0]
	if got.Name != "terminal" || got.Version != "0.0.42" || got.Process != "/installed/terminal/dist/project-sidecar-terminal" || got.PID != 42 {
		t.Fatalf("open=%+v", got)
	}
	if got.Token != "" || got.SecretNames != "" {
		t.Fatalf("open status exposed secrets: %+v", got)
	}
}
