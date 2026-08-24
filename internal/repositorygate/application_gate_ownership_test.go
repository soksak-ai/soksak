package repositorygate

import (
	"os"
	"strings"
	"testing"
)

func TestApplicationGatesCannotConsumeAmbientBinaries(t *testing.T) {
	tags := map[string]string{
		"internal/application/restore_gate_test.go":       "//go:build applicationgate",
		"internal/application/capture_focus_gate_test.go": "//go:build applicationgate",
		"internal/application/native_close_gate_test.go":  "//go:build darwin && applicationgate",
	}
	for path, required := range tags {
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(string(body), required+"\n") {
			t.Errorf("%s is not isolated by %q", path, required)
		}
	}

	body, err := os.ReadFile("Taskfile.yml")
	if err != nil {
		t.Fatal(err)
	}
	source := string(body)
	verify := taskBlock(t, source, "verify")
	if !strings.Contains(verify, "task: verify:application") {
		t.Fatal("verify does not delegate real-binary tests to the application gate")
	}
	for _, removed := range []string{"task: verify:restore", "task: verify:native-close"} {
		if strings.Contains(verify, removed) {
			t.Errorf("verify retains split application path %q", removed)
		}
	}
	application := taskBlock(t, source, "verify:application")
	for _, required := range []string{
		"task: build",
		"task: build:sok",
		"go test -tags=applicationgate ./internal/application -count=1",
		"task: verify:native-close-repetition",
	} {
		if !strings.Contains(application, required) {
			t.Errorf("application gate is missing %q", required)
		}
	}
	repetition := taskBlock(t, source, "verify:native-close-repetition")
	for _, required := range []string{
		"internal: true",
		"platforms: [darwin]",
		"-tags=applicationgate",
		"TestNativeTrafficLightCloseEndsTheAddressedWindowWithoutTakingInput",
		"-count=2",
	} {
		if !strings.Contains(repetition, required) {
			t.Errorf("native-close repetition is missing %q", required)
		}
	}
	if strings.Contains(taskBlock(t, source, "verify:go"), "applicationgate") {
		t.Fatal("generic Go verification opts into real-binary application gates")
	}
}
