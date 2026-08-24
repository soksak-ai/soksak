package repositorygate

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestApplicationGateStartupConsumesReadinessWithoutPolling(t *testing.T) {
	body, err := os.ReadFile(filepath.Join(repositoryRoot, "internal", "application", "restore_gate_test.go"))
	if err != nil {
		t.Fatal(err)
	}
	source := string(body)
	for _, forbidden := range []string{"startupPollInterval", "time.Sleep("} {
		if strings.Contains(source, forbidden) {
			t.Errorf("application gate startup retains %q", forbidden)
		}
	}
	if !strings.Contains(source, "soksak.control.ready") {
		t.Fatal("application gate startup does not consume the readiness event")
	}
}
