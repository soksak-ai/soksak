package install

import (
	"errors"
	"strings"
	"testing"

	"github.com/soksak-ai/soksak-core/core/files"
)

// TestTheShellItIsGivenIsTheShellItAsks proves the shell is an argument. If the
// body read $SHELL this assertion could not pass, because the value below is
// not a shell any machine has.
func TestTheShellItIsGivenIsTheShellItAsks(t *testing.T) {
	runner := &scriptedRunner{outcome: files.Outcome{Stdout: "/opt/homebrew\n"}}
	dirs, err := npmGlobalDirs("/opt/fixture/myshell", "darwin", runner)
	if err != nil {
		t.Fatalf("asking: %v", err)
	}
	if runner.program != "/opt/fixture/myshell" {
		t.Errorf("program = %q, want the shell it was given", runner.program)
	}
	if dirs != (NpmDirs{BinDir: "/opt/homebrew/bin", LibDir: "/opt/homebrew/lib"}) {
		t.Errorf("dirs = %+v, want the two joins the caller composes from", dirs)
	}
}

// TestTheLoginFlagIsPresent holds the reason this command exists at all. A
// process launched from a desktop environment inherits a PATH without a version
// manager's shims; `-l` makes the shell rebuild PATH from rc/profile, so the
// answer is the user's terminal's answer. Without it the command reports "npm
// is not installed" on a machine that has it.
func TestTheLoginFlagIsPresent(t *testing.T) {
	_, args, err := npmPrefixArgv("/bin/zsh", "darwin")
	if err != nil {
		t.Fatalf("assembling: %v", err)
	}
	if len(args) != 2 || !strings.Contains(args[0], "l") {
		t.Fatalf("args = %q, want a login shell flag", args)
	}
	if args[1] != "npm prefix -g" {
		t.Errorf("args[1] = %q, want the prefix question", args[1])
	}
}

// TestAnEmptyPrefixIsNotARootPath is the wrong answer this rule exists to stop.
// A blank prefix builds "/bin" and "/lib", and binary_integrity would then read
// the system directories and report a user's tool as installed there.
func TestAnEmptyPrefixIsNotARootPath(t *testing.T) {
	for _, printed := range []string{"", "  \n ", "\n\n"} {
		if _, err := npmDirsFromPrefix(printed); err == nil {
			t.Errorf("%q was accepted as a prefix", printed)
		}
	}
}

// TestTheLastLineIsTheAnswer keeps an rc banner out of the path. A login shell
// runs the user's profile first, and anything it prints arrives ahead of npm's
// answer — taking the first line hands a greeting back as a directory.
func TestTheLastLineIsTheAnswer(t *testing.T) {
	dirs, err := npmDirsFromPrefix("nvm: using node v20\n/workspace/.nvm/versions/node/v20.11.0\n")
	if err != nil {
		t.Fatalf("splitting: %v", err)
	}
	if dirs.BinDir != "/workspace/.nvm/versions/node/v20.11.0/bin" {
		t.Errorf("binDir = %q, want the last line", dirs.BinDir)
	}
}

// TestAShellThatCannotRunIsNotAnAbsentNpm keeps a misconfiguration visible. One
// wrong injected shell path would otherwise send the user to install a thing
// they already have.
func TestAShellThatCannotRunIsNotAnAbsentNpm(t *testing.T) {
	if _, err := npmGlobalDirs("/bin/zsh", "darwin", &scriptedRunner{err: errors.New("no such file")}); err == nil {
		t.Fatal("a shell that could not start answered as an absent npm")
	}
}

// TestNpmAnsweringNonZeroFailsWithTheExitCode separates "npm is not on the
// PATH" from "npm printed nothing". Both would otherwise arrive as the same
// empty-prefix refusal, and only one of them is about npm.
func TestNpmAnsweringNonZeroFailsWithTheExitCode(t *testing.T) {
	_, err := npmGlobalDirs("/bin/zsh", "darwin", &scriptedRunner{outcome: files.Outcome{ExitCode: 127}})
	if err == nil {
		t.Fatal("a non-zero npm was read as an answer")
	}
	if !strings.Contains(err.Error(), "127") {
		t.Errorf("the refusal does not carry the exit code: %v", err)
	}
}

// TestMissingDependenciesAreRefusedByName covers the three things this command
// cannot invent: the platform, the shell, and a way to run one.
func TestMissingDependenciesAreRefusedByName(t *testing.T) {
	for _, refusal := range []struct {
		what  string
		call  func() error
		names string
	}{
		{"no platform", func() error { _, _, err := npmPrefixArgv("/bin/zsh", ""); return err }, "install.Deps.OS"},
		{"no shell", func() error { _, _, err := npmPrefixArgv("", "darwin"); return err }, "install.Deps.LoginShell"},
		{"no runner", func() error { _, err := npmGlobalDirs("/bin/zsh", "darwin", nil); return err }, "install.Deps.Run"},
	} {
		err := refusal.call()
		if err == nil {
			t.Errorf("%s was accepted", refusal.what)
			continue
		}
		if !strings.Contains(err.Error(), refusal.names) {
			t.Errorf("%s: the refusal does not name what to supply: %v", refusal.what, err)
		}
	}
}

// TestWindowsIsRefusedRatherThanGuessed keeps a wrong answer from wearing the
// clothes of a fact. npm's global layout on Windows is <prefix>\<name>.cmd and
// <prefix>\node_modules — answering the unix bin/lib join there would make
// every installed tool read as missing through binary_integrity.
//
// The platform being an argument is what lets one build show both shapes, which
// is the same reason it is an argument everywhere else in this core.
func TestWindowsIsRefusedRatherThanGuessed(t *testing.T) {
	_, _, err := npmPrefixArgv("cmd.exe", "windows")
	if err == nil {
		t.Fatal("Windows was answered with the unix layout")
	}
	if !strings.Contains(err.Error(), "node_modules") {
		t.Errorf("the refusal does not say what the Windows layout is: %v", err)
	}

	if _, _, err := npmPrefixArgv("/bin/zsh", "darwin"); err != nil {
		t.Fatalf("the same build must still answer for unix: %v", err)
	}
}
