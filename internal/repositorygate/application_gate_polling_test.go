package repositorygate

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestApplicationGateStartupConsumesReadinessWithoutPolling(t *testing.T) {
	var source string
	for _, name := range []string{"restore_gate_test.go", "readiness_gate_test.go"} {
		body, err := os.ReadFile(filepath.Join(repositoryRoot, "internal", "application", name))
		if err != nil {
			t.Fatal(err)
		}
		source += string(body)
	}
	for _, forbidden := range []string{"startupPollInterval", "time.Sleep("} {
		if strings.Contains(source, forbidden) {
			t.Errorf("application gate startup retains %q", forbidden)
		}
	}
	if !strings.Contains(source, "soksak.control.ready") {
		t.Fatal("application gate startup does not consume the readiness event")
	}
}
