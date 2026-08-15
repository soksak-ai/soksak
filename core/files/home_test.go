package files

import (
	"path/filepath"
	"strings"
	"testing"
)

// The home is an argument, and this is the assertion an ambient read cannot
// pass: one input, two injected homes, two answers. The two homes are
// different values — the user home (`~`) and the identity home
// (`~/.soksak-wails`) — and main.go holds both, so
// the wiring can trivially hand over the wrong one.
func TestOneInputAndTwoHomesGiveTwoAnswers(t *testing.T) {
	fromA, err := expand("~/rc", "/homes/a")
	if err != nil {
		t.Fatalf("expanding against /homes/a: %v", err)
	}
	fromB, err := expand("~/rc", "/homes/b")
	if err != nil {
		t.Fatalf("expanding against /homes/b: %v", err)
	}
	if fromA == fromB {
		t.Fatalf("both homes answered %q — the home is not being used", fromA)
	}
	if fromA != filepath.Join("/homes/a", "rc") {
		t.Errorf("expand(~/rc, /homes/a) = %q", fromA)
	}
	if fromB != filepath.Join("/homes/b", "rc") {
		t.Errorf("expand(~/rc, /homes/b) = %q", fromB)
	}
}

func TestABareTildeIsTheHomeItself(t *testing.T) {
	got, err := expand("~", "/homes/a")
	if err != nil {
		t.Fatalf("expanding a bare tilde: %v", err)
	}
	if got != "/homes/a" {
		t.Errorf("expand(~) = %q, want the home itself", got)
	}
}

// `~user/x` names someone else's home, which needs the user database to
// resolve. Guessing it as <home>/user would silently read the wrong tree, so
// the tilde is left where it is and the path fails later by its real name.
func TestAnotherUsersTildeIsLeftLiteral(t *testing.T) {
	got, err := expand("~someone/x", "/homes/a")
	if err != nil {
		t.Fatalf("expanding another user's tilde: %v", err)
	}
	if got != "~someone/x" {
		t.Errorf("expand(~someone/x) = %q, want it left alone", got)
	}
}

// One thing we cannot do must not block the rest: a process that was given no
// home still answers absolute paths.
func TestAPathWithoutATildeNeedsNoHome(t *testing.T) {
	got, err := expand("/var/log/system.log", "")
	if err != nil {
		t.Fatalf("an absolute path must answer with no home: %v", err)
	}
	if got != "/var/log/system.log" {
		t.Errorf("expand = %q", got)
	}
}

// The refusal has to say what to inject. A process that guesses its own home
// walks a different tree, and that wrong answer arrives as a different listing
// rather than as an error.
func TestATildeWithNoHomeSaysWhatToInject(t *testing.T) {
	_, err := expand("~/rc", "")
	if err == nil {
		t.Fatal("a tilde path with no home must refuse")
	}
	if !strings.Contains(err.Error(), "UserHome") {
		t.Errorf("the refusal does not name what to supply: %v", err)
	}
}

func TestRequireHomeRefusesByNameAndAnswersWhenGiven(t *testing.T) {
	if _, err := requireHome(""); err == nil {
		t.Fatal("a missing home must refuse")
	}
	home, err := requireHome("/homes/a")
	if err != nil {
		t.Fatalf("a supplied home must be accepted: %v", err)
	}
	if home != "/homes/a" {
		t.Errorf("requireHome = %q", home)
	}
}
