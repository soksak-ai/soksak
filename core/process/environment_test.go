package process

import (
	"strings"
	"testing"
)

func envOf(entries []string) map[string]string {
	seen := map[string]string{}
	for _, entry := range entries {
		name, value, _ := strings.Cut(entry, "=")
		seen[name] = value
	}
	return seen
}

// The denylist keeps the interface variables and strips the internal ones.
// A child here is an arbitrary non-interactive program (LSP, MCP, ACP, a CLI),
// so a whole-environment allowlist would break legitimate tool variables
// (proxies, language homes); only internal SOKSAK_* is removed, fail-closed.
func TestInternalSoksakNamesAreStrippedAndTheInterfaceSurvives(t *testing.T) {
	inherited := []string{
		"PATH=/bin", "HOME=/h", "USER=u",
		"SOKSAK_HOME=/old", "SOKSAK_SOCKET=/s", "SOKSAK_WINDOW=w-1",
		"SOKSAK_PARENT=p", "SOKSAK_CLI_DIR=/c", "SOKSAK_CALLER_TAB=t",
		"SOKSAK_PANE=pane-9",
		"SOKSAK_VAULT_KEY=k", "SOKSAK_VAULT_PATH=/v", "SOKSAK_SECRET_0=s",
		"SOKSAK_PTYD_BIN=/b", "SOKSAK_ENV=e",
	}

	child := envOf(childEnvironment(environmentRequest{Inherited: inherited, Home: "/home"}))

	for _, name := range []string{
		"PATH", "HOME", "USER",
		"SOKSAK_SOCKET", "SOKSAK_WINDOW", "SOKSAK_PARENT", "SOKSAK_CLI_DIR", "SOKSAK_CALLER_TAB",
	} {
		if _, kept := child[name]; !kept {
			t.Errorf("%s must survive: it is the interface a child talks to the app through", name)
		}
	}
	for _, name := range []string{
		"SOKSAK_VAULT_KEY", "SOKSAK_VAULT_PATH", "SOKSAK_SECRET_0", "SOKSAK_PTYD_BIN", "SOKSAK_ENV",
	} {
		if _, kept := child[name]; kept {
			t.Errorf("%s is internal and must not reach a child", name)
		}
	}
	// SOKSAK_PANE was once carried as "the old transitional
	// name — removal condition: every session replaced". A fresh build has no
	// session to carry, and this repository forbids compatibility layers.
	if _, kept := child["SOKSAK_PANE"]; kept {
		t.Error("SOKSAK_PANE is a retired transitional name; nothing here carries a session that needs it")
	}
}

// The home a child inherits is the one that was passed in, never the one this
// process happens to have.
func TestSoksakHomeComesFromTheGivenHome(t *testing.T) {
	child := envOf(childEnvironment(environmentRequest{
		Inherited: []string{"SOKSAK_HOME=/whatever-this-process-has"},
		Home:      "/given/home",
	}))
	if child["SOKSAK_HOME"] != "/given/home" {
		t.Fatalf("SOKSAK_HOME = %q, want the injected home", child["SOKSAK_HOME"])
	}
}

// Proof that nothing consults the ambient environment: one entry in, one entry
// out plus only what the rules add.
func TestOneInheritedEntryProducesOnlyItselfAndWhatTheRulesAdd(t *testing.T) {
	entries := childEnvironment(environmentRequest{Inherited: []string{"PATH=/bin"}, Home: "/home"})
	want := []string{"PATH=/bin", "SOKSAK_HOME=/home"}
	if len(entries) != len(want) {
		t.Fatalf("child environment = %v, want exactly %v", entries, want)
	}
	for index, entry := range want {
		if entries[index] != entry {
			t.Fatalf("child environment = %v, want %v", entries, want)
		}
	}
}

// Remove and the AI scrub sum. A caller requesting both gets both, and
// neither list has to know about the other.
func TestRemoveAndTheAIScrubSum(t *testing.T) {
	inherited := []string{"KEEP=1", "DROP=2"}
	for _, name := range AISessionEnv {
		inherited = append(inherited, name+"=set")
	}
	child := envOf(childEnvironment(environmentRequest{
		Inherited: inherited,
		Home:      "/home",
		Remove:    []string{"DROP"},
		ScrubAI:   true,
	}))
	if _, kept := child["KEEP"]; !kept {
		t.Error("an unnamed variable is not removed")
	}
	if _, kept := child["DROP"]; kept {
		t.Error("Remove did not remove DROP")
	}
	for _, name := range AISessionEnv {
		if _, kept := child[name]; kept {
			t.Errorf("%s is AI session context: a child inheriting it reports itself as an agent inside an agent", name)
		}
	}
}

// Removal is applied after set, so a name in both is removed.
// Keeping that order means one spelling of "unset this" always wins.
func TestRemoveBeatsSet(t *testing.T) {
	child := envOf(childEnvironment(environmentRequest{
		Home:   "/home",
		Set:    map[string]string{"X": "1"},
		Remove: []string{"X"},
	}))
	if _, kept := child["X"]; kept {
		t.Fatal("Remove is applied after Set, so X must be gone")
	}
}

// A secret and a plain entry sharing a name: the secret wins, because it is
// appended last. A half-configured child reports its failure as anything but a
// secret problem.
func TestASecretBeatsAPlainEntryOfTheSameName(t *testing.T) {
	child := envOf(childEnvironment(environmentRequest{
		Home:    "/home",
		Set:     map[string]string{"TOKEN": "plain"},
		Secrets: [][2]string{{"TOKEN", "sk-real"}},
	}))
	if child["TOKEN"] != "sk-real" {
		t.Fatalf("TOKEN = %q, want the secret", child["TOKEN"])
	}
}

// The result is never nil. A nil slice handed to os/exec means "read the
// ambient environment", which is the one thing this package must never do.
func TestAnEmptyRequestStillProducesASlice(t *testing.T) {
	entries := childEnvironment(environmentRequest{})
	if entries == nil {
		t.Fatal("a nil environment makes os/exec read the ambient one")
	}
}
