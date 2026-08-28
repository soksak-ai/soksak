package repositorygate

import (
	"os"
	"strings"
	"testing"
)

func TestLaunchPublishesOneProcessLabel(t *testing.T) {
	body, err := os.ReadFile("internal/application/run.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(body)
	for _, required := range []string{
		`os.Getenv(controlwire.ProcessLabelEnvironment)`,
		"launchProcessLabel",
		"ProcessLabel:",
	} {
		if !strings.Contains(source, required) {
			t.Errorf("application launch does not own %q", required)
		}
	}
	read := strings.Index(source, `os.Getenv(controlwire.ProcessLabelEnvironment)`)
	units := strings.Index(source, "sidecar.NewHost")
	boot := strings.Index(source, "boot.RegisterCore")
	if read < 0 || units < read || boot < units {
		t.Fatalf("process label ownership order read=%d sidecars=%d boot=%d", read, units, boot)
	}
	if !strings.Contains(source[units:boot], "ProcessLabel: processLabel") {
		t.Error("sidecar host does not receive the launch-owned process label")
	}
	if !strings.Contains(source[boot:], "ProcessLabel: processLabel") {
		t.Error("Core public environment does not receive the launch-owned process label")
	}
}
