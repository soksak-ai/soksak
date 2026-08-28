package sidecar

import (
	"encoding/json"
	"testing"
)

func TestOpenUsesThePublicLowerCamelCaseFields(t *testing.T) {
	body, err := json.Marshal(Open{Name: "provider", Address: "address", Protocol: 2, PID: 7, ProcessLabel: "soksakv3"})
	if err != nil {
		t.Fatal(err)
	}
	const wanted = `{"name":"provider","address":"address","protocol":2,"pid":7,"processLabel":"soksakv3"}`
	if string(body) != wanted {
		t.Fatalf("open JSON=%s want=%s", body, wanted)
	}
}
