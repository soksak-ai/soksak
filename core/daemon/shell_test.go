package daemon

import (
	"strings"
	"testing"
)

// The line arrives whole. A daemon declaration is a shell command and
// release.publish sends a multi-line script; anything that split it here would
// have to reimplement quoting, and `find … \( -name '*.tar.gz' … \)` comes
// apart at the first space.
func TestTheDaemonLineReachesTheShellWhole(t *testing.T) {
	script := "set -eu\nfind 'a b' \\( -name '*.tar.gz' \\) | sort"

	program, args, err := daemonArgv("/bin/zsh", script)
	if err != nil {
		t.Fatalf("building the daemon command line: %v", err)
	}

	if program != "/bin/zsh" {
		t.Errorf("program = %q, want the injected shell", program)
	}
	if len(args) != 2 || args[1] != script {
		t.Fatalf("args = %q, want the script as one argument", args)
	}
}

// -l is the load-bearing flag: the login shell rebuilds PATH from rc/profile,
// so a daemon started from a GUI-launched process finds the same node/npm the
// user's terminal finds.
func TestTheDaemonRunsThroughALoginShell(t *testing.T) {
	_, args, err := daemonArgv("/bin/zsh", "npm run dev")
	if err != nil {
		t.Fatalf("building the daemon command line: %v", err)
	}
	if args[0] != "-lc" {
		t.Errorf("args[0] = %q, want -lc — without -l the daemon inherits this process's PATH", args[0])
	}
}

func TestAnEmptyDaemonLineIsRefusedByName(t *testing.T) {
	if _, _, err := daemonArgv("/bin/zsh", "   "); err == nil {
		t.Fatal("an empty command line built an argv; the shell would start and exit at once")
	} else if !strings.Contains(err.Error(), "cmd") {
		t.Errorf("the refusal %q does not name the argument", err)
	}
}

func TestNoShellIsRefusedByNameRatherThanGuessed(t *testing.T) {
	_, _, err := daemonArgv("", "npm run dev")
	if err == nil {
		t.Fatal("a daemon was built with no shell; something ambient would have to answer for it")
	}
	if !strings.Contains(err.Error(), "LoginShell") {
		t.Errorf("the refusal %q does not name what the host must supply", err)
	}
}
