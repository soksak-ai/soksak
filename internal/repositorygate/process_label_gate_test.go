package repositorygate

import (
	"os"
	"strings"
	"testing"
)

func TestLaunchAppliesAndPublishesOneProcessLabel(t *testing.T) {
	body, err := os.ReadFile("internal/application/run.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(body)
	for _, required := range []string{
		`os.Getenv(controlwire.ProcessLabelEnvironment)`,
		"processLabelFromEnvironment",
		"ApplyProcessLabel",
		"ProcessLabel:",
	} {
		if !strings.Contains(source, required) {
			t.Errorf("application launch does not own %q", required)
		}
	}
	read := strings.Index(source, `os.Getenv(controlwire.ProcessLabelEnvironment)`)
	apply := strings.Index(source, "ApplyProcessLabel")
	units := strings.Index(source, "sidecar.NewHost")
	if read < 0 || apply < read || units < apply {
		t.Errorf("process label order read=%d apply=%d sidecars=%d", read, apply, units)
	}
}
