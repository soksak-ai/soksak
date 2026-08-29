package process

import (
	"strings"
	"testing"
)

// A daemon starts a child too, and it needs the same environment rule this
// package already owns. A second copy would drift the moment either changed —
// and the way it drifts is that an internal name stops being stripped, so a
// vault master key enters a child.
//
// So the rule is lent rather than copied: this package answers, and whoever
// starts a process requires.
func TestTheChildEnvironmentRuleIsLentRatherThanCopied(t *testing.T) {
	inherited := []string{
		"PATH=/usr/bin",
		"SOKSAK_HOME=/somewhere-else",
		"SOKSAK_MASTER_KEY=secret",
		"SOKSAK_SOCKET=/tmp/s.sock",
	}

	built := ChildEnvironment(inherited, "/home", map[string]string{"TERM": "xterm"})

	joined := strings.Join(built, "\n")
	if strings.Contains(joined, "SOKSAK_MASTER_KEY") {
		t.Errorf("an internal name reached the child: %v", built)
	}
	for _, entitled := range []string{"SOKSAK_HOME=/home", "SOKSAK_SOCKET=/tmp/s.sock"} {
		if !strings.Contains(joined, entitled) {
			t.Errorf("the child lost a handle it is entitled to: %s", entitled)
		}
	}
	if !strings.Contains(joined, "PATH=/usr/bin") {
		t.Error("the inherited environment was dropped")
	}
	if !strings.Contains(joined, "TERM=xterm") {
		t.Error("the caller's own entry was dropped")
	}
	// The home is the application's own truth, not whatever was inherited.
	if strings.Contains(joined, "/somewhere-else") {
		t.Errorf("an inherited home outlived the one this process passed: %v", built)
	}
}

// An override beats what was inherited, or a caller cannot correct anything.
func TestAnOverrideBeatsTheInheritedValue(t *testing.T) {
	built := ChildEnvironment([]string{"TERM=dumb"}, "/home", map[string]string{"TERM": "xterm-256color"})

	joined := strings.Join(built, "\n")
	if strings.Contains(joined, "TERM=dumb") || !strings.Contains(joined, "TERM=xterm-256color") {
		t.Errorf("the override did not win: %v", built)
	}
}
