package ai

import "testing"

// TestDetectReadsTheFirstTokensBasename fixes what counts as launching an
// agent. The terminal hands over whole command lines, so the rule has to
// survive a path, arguments, and leading whitespace at once.
func TestDetectReadsTheFirstTokensBasename(t *testing.T) {
	for _, probe := range []struct {
		commandLine string
		want        Kind
		launched    bool
	}{
		{commandLine: "claude", want: Claude, launched: true},
		{commandLine: "  claude   --resume  ", want: Claude, launched: true},
		{commandLine: "/usr/local/bin/claude --resume", want: Claude, launched: true},
		{commandLine: "codex", want: Codex, launched: true},
		{commandLine: "codex --model o3", want: Codex, launched: true},
		{commandLine: "/opt/homebrew/bin/codex", want: Codex, launched: true},

		{commandLine: "", launched: false},
		{commandLine: "   ", launched: false},
		{commandLine: "git status", launched: false},
		// The basename must equal the name. A prefix or a suffix match would
		// tag every `claude-monitor` and `my-codex-wrapper` as an agent, and a
		// terminal block would then claim a session that never existed.
		{commandLine: "claude-monitor", launched: false},
		{commandLine: "notclaude", launched: false},
		{commandLine: "/usr/bin/claudex", launched: false},
		// An argument that names an agent is not the command being run.
		{commandLine: "echo claude", launched: false},
	} {
		kind, launched := Detect(probe.commandLine)
		if launched != probe.launched {
			t.Errorf("Detect(%q) launched=%v, want %v", probe.commandLine, launched, probe.launched)
			continue
		}
		if launched && kind != probe.want {
			t.Errorf("Detect(%q) = %q, want %q", probe.commandLine, kind, probe.want)
		}
	}
}
