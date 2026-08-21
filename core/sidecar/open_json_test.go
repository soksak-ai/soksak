package sidecar

import (
	"encoding/json"
	"testing"
)

func TestOpenUsesThePublicLowerCamelCaseFields(t *testing.T) {
	body, err := json.Marshal(Open{Name: "provider", Address: "address", Protocol: 1, PID: 7})
	if err != nil {
		t.Fatal(err)
	}
	const wanted = `{"name":"provider","address":"address","protocol":1,"pid":7}`
	if string(body) != wanted {
		t.Fatalf("open JSON=%s want=%s", body, wanted)
	}
}
