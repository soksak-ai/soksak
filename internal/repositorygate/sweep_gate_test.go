package repositorygate

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// A comment sweep changes comments. This proves it changed nothing else.
//
// A sweep is handed to many agents at once, and the failure that matters is not
// a clumsy sentence — it is an agent that rewrites a line of code while it is in
// there. That failure is silent: the tests still pass if the rewrite happened to
// be equivalent, and the review reads as prose so nobody looks at the code.
//
// Stripping the comments from both sides and comparing what is left is exact.
// It holds whatever model runs the sweep, so the choice of model becomes a
// measurement rather than a judgement about how careful a model is.
//
// SWEEP_BASE names the ref the sweep started from. Without it there is no sweep
// to check and this reports nothing.
func TestASweepChangesNoCode(t *testing.T) {
	base := os.Getenv("SWEEP_BASE")
	if base == "" {
		t.Skip("SWEEP_BASE is unset; run it as SWEEP_BASE=<ref> go test -run TestASweepChangesNoCode .")
	}

	changed, err := changedFiles(base)
	if err != nil {
		t.Fatalf("listing what changed since %s: %v", base, err)
	}
	if len(changed) == 0 {
		t.Fatalf("nothing changed since %s, so there is no sweep to check", base)
	}

	checked := 0
	for _, path := range changed {
		if !scannedCode[filepath.Ext(path)] {
			continue
		}
		before, err := fileAt(base, path)
		if err != nil {
			// A file the sweep added has no side to compare against.
			continue
		}
		after, err := os.ReadFile(path)
		if err != nil {
			// A file the sweep deleted is not a comment change, and the
			// reviewer needs to be told rather than have it pass quietly.
			t.Errorf("%s was deleted by the sweep", path)
			continue
		}
		checked++
		if code(before) != code(string(after)) {
			t.Errorf("%s: the sweep changed code, not only comments.\n"+
				"Restore the code and rewrite only the comment.", path)
		}
	}
	if checked == 0 {
		t.Fatalf("no source file changed since %s; the sweep touched nothing this gate reads", base)
	}
	t.Logf("%d files compared with their comments stripped", checked)
}

// code is the file with every comment removed and whitespace collapsed.
//
// Whitespace is collapsed because removing a comment changes the blank space
// around it, and that is not a code change. Everything else — every string,
// every identifier, every operator — is compared exactly.
func code(source string) string {
	var kept []string
	for _, line := range strings.Split(codeOutside(source), "\n") {
		if fields := strings.Fields(line); len(fields) > 0 {
			kept = append(kept, strings.Join(fields, " "))
		}
	}
	return strings.Join(kept, "\n")
}

func changedFiles(base string) ([]string, error) {
	out, err := exec.Command("git", "diff", "--name-only", base).Output()
	if err != nil {
		return nil, err
	}
	var paths []string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line != "" {
			paths = append(paths, line)
		}
	}
	return paths, nil
}

func fileAt(ref, path string) (string, error) {
	out, err := exec.Command("git", "show", ref+":"+path).Output()
	return string(out), err
}
