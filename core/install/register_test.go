package install

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/soksak-ai/soksak-core/core/control"
	"github.com/soksak-ai/soksak-core/core/files"
)

type recordingChange struct {
	event   string
	payload any
}

func TestArtifactInstallCommandsCommitAndPublishEnvironmentChange(t *testing.T) {
	home := t.TempDir()
	archive := tgz(t, archiveEntry{name: "plugin.json", body: `{"id":"view","version":"0.0.1"}`})
	var changes []recordingChange
	registry := control.NewRegistry()
	Register(registry, Deps{Home: home, Fetcher: memoryFetcher{body: archive}, Changed: func(event string, payload any) { changes = append(changes, recordingChange{event, payload}) }})
	identity := ArtifactIdentity{Kind: "plugin", ID: "view", Version: "0.0.1"}
	beginValue, err := registry.Invoke("artifact_install_begin", arguments(t, map[string]any{"registryId": "official", "root": identity}))
	if err != nil {
		t.Fatal(err)
	}
	transaction := beginValue.(Transaction)
	stageValue, err := registry.Invoke("artifact_install_stage", arguments(t, map[string]any{"transactionId": transaction.TransactionID, "registryId": "official", "identity": identity, "artifact": Artifact{URL: "https://example.invalid/view.tgz", Size: uint64(len(archive)), SHA256: sha256Hex(archive), Format: "tgz", Manifest: "plugin.json", Entrypoints: []string{"plugin.json"}}}))
	if err != nil {
		t.Fatal(err)
	}
	staged := stageValue.(StagedArtifact)
	if _, err := registry.Invoke("artifact_install_read_utf8", arguments(t, map[string]any{"transactionId": transaction.TransactionID, "handle": staged.Handle, "path": "plugin.json"})); err != nil {
		t.Fatal(err)
	}
	verified := VerifiedComponent{Kind: "plugin", ID: "view", Version: "0.0.1", RegistryID: "official", SourceRepository: "https://github.com/example/view", SourceCommit: "0123456789abcdef0123456789abcdef01234567", ArtifactURL: "https://example.invalid/view.tgz", ArtifactSHA256: staged.SHA256, StagedHandle: staged.Handle}
	commitValue, err := registry.Invoke("artifact_install_commit", arguments(t, map[string]any{"transactionId": transaction.TransactionID, "expectedRevision": uint64(0), "components": []VerifiedComponent{verified}}))
	if err != nil {
		t.Fatal(err)
	}
	if commitValue.(CommitResult).Revision != 1 {
		t.Fatalf("commit=%+v", commitValue)
	}
	if len(changes) != 1 || changes[0].event != "environment.changed" {
		t.Fatalf("changes=%+v", changes)
	}
}

func arguments(t *testing.T, pairs map[string]any) control.Args {
	t.Helper()
	args := control.Args{}
	for name, value := range pairs {
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatalf("encoding %s: %v", name, err)
		}
		args[name] = encoded
	}
	return args
}

// TestTheGroupAnswersWhatItClaims pins the table. A command that is registered
// under a different name than the frontend calls is invisible until a user
// opens it, and then it reads as a broken application rather than an unbuilt
// one.
func TestTheGroupAnswersWhatItClaims(t *testing.T) {
	registry := control.NewRegistry()
	Register(registry, Deps{Home: t.TempDir(), OS: "darwin", Arch: "arm64", LoginShell: "/bin/zsh", Run: &scriptedRunner{}, Fetcher: memoryFetcher{}})

	table := registry.Describe()
	served := []string{}
	for _, command := range table.Commands {
		served = append(served, command.Name)
		if command.Owner != control.OwnerCore {
			t.Errorf("%s is owned by %s; nothing in this group needs a window", command.Name, command.Owner)
		}
	}
	sort.Strings(served)

	want := []string{
		"artifact_install_begin", "artifact_install_commit", "artifact_install_read_utf8",
		"artifact_install_rollback", "artifact_install_stage", "binary_integrity",
		"host_artifact_target", "npm_global_dirs", "probe_binary", "theme_install",
	}
	if strings.Join(served, ",") != strings.Join(want, ",") {
		t.Errorf("served = %v, want %v", served, want)
	}

	refused := []string{}
	for _, entry := range table.Unserved {
		refused = append(refused, entry.Name)
	}
	sort.Strings(refused)
	wantRefused := []string{"plugin_scaffold"}
	if strings.Join(refused, ",") != strings.Join(wantRefused, ",") {
		t.Errorf("refused = %v, want %v", refused, wantRefused)
	}
}

// A command name in this build is snake_case with at least two parts
// (plugin_manifest_list, artifact_install_commit). An unblocking action is an imperative
// the reader can act on.
var (
	commandName      = regexp.MustCompile(`\b[a-z][a-z0-9]*(_[a-z0-9]+)+\b`)
	unblockingAction = regexp.MustCompile(`\b(Serve|Give|Port|Register|Build)\b`)
)

// TestEveryRefusalNamesWhatBlocksIt is what keeps a refusal from being a stub
// with better manners. "Not written yet" and "cannot work here" send a caller
// to two different places, and a reason with no fact in it sends them to
// neither.
func TestEveryRefusalNamesWhatBlocksIt(t *testing.T) {
	registry := control.NewRegistry()
	Register(registry, Deps{})

	for _, entry := range registry.Describe().Unserved {
		if len(entry.BlockedBy) < 40 {
			t.Errorf("%s: the reason is too short to act on: %q", entry.Name, entry.BlockedBy)
		}
		// Every refusal is blocked by work with a name. A reason that names no
		// command is an opinion, and the caller cannot look it up.
		//
		// The names are matched by shape, not by a list. A list would be a
		// second copy of what blocks this build, and it goes stale the moment
		// one of them lands — measured 2026-08-15, the loader was ported and
		// the list still required its name in reasons that no longer mention it.
		if !commandName.MatchString(entry.BlockedBy) {
			t.Errorf("%s: the reason names no command: %q", entry.Name, entry.BlockedBy)
		}
		if !unblockingAction.MatchString(entry.BlockedBy) {
			t.Errorf("%s: the reason does not say what would unblock it: %q", entry.Name, entry.BlockedBy)
		}
	}
}

// TestARefusedCommandCarriesItsReasonToTheCaller. The reason has to travel: it
// arrives at a caller as the text of an error, with no file to look in.
func TestARefusedArtifactCommandCarriesItsReasonToTheCaller(t *testing.T) {
	registry := control.NewRegistry()
	Register(registry, Deps{})

	_, err := registry.Invoke("artifact_install_commit", nil)
	if err == nil {
		t.Fatal("a refused command answered")
	}
	// The error states the command's own reason, not a generic refusal. The
	// reason is compared to the table so this stays true when the reason
	// changes.
	if !strings.Contains(err.Error(), installTransactionBlocked) {
		t.Errorf("the error does not carry the blocking fact: %v", err)
	}
}

// TestTheHandlersReadTheArgumentNamesTheFrontendSends. The argument shapes
// belong to the caller, and a handler that reads binPath as bin_path answers
// "missing argument" to a call that supplied everything.
func TestTheHandlersReadTheArgumentNamesTheFrontendSends(t *testing.T) {
	home := t.TempDir()
	source := filepath.Join(t.TempDir(), "midnight.json")
	if err := os.WriteFile(source, []byte(`{"name":"midnight"}`), 0o644); err != nil {
		t.Fatalf("writing the theme: %v", err)
	}
	registry := control.NewRegistry()
	Register(registry, Deps{
		Home: home, OS: "darwin", Arch: "arm64", LoginShell: "/bin/zsh",
		Run: &scriptedRunner{outcome: files.Outcome{Stdout: "/opt/homebrew\n"}},
	})

	for _, call := range []struct {
		name string
		args map[string]any
		want any
	}{
		{"binary_integrity", map[string]any{"binPath": filepath.Join(home, "bin"), "libPath": filepath.Join(home, "lib")}, Integrity{}},
		{"probe_binary", map[string]any{"bin": "/opt/bin/node", "args": []string{"--version"}}, Probe{OK: true, Stdout: "/opt/homebrew\n"}},
		{"npm_global_dirs", map[string]any{}, NpmDirs{BinDir: "/opt/homebrew/bin", LibDir: "/opt/homebrew/lib"}},
		{"host_artifact_target", map[string]any{}, "aarch64-apple-darwin"},
		{"theme_install", map[string]any{"path": source}, filepath.Join(home, "themes", "midnight.json")},
	} {
		got, err := registry.Invoke(call.name, arguments(t, call.args))
		if err != nil {
			t.Errorf("%s: %v", call.name, err)
			continue
		}
		if got != call.want {
			t.Errorf("%s = %#v, want %#v", call.name, got, call.want)
		}
	}
}

// TestAGroupWithNoDependenciesRefusesByNameRatherThanAnswering. A build wired
// with nothing still registers every name — the caller is told what is missing
// instead of hearing "unknown command", which it cannot tell from a command
// this build forgot.
func TestAGroupWithNoDependenciesRefusesByNameRatherThanAnswering(t *testing.T) {
	registry := control.NewRegistry()
	Register(registry, Deps{})

	for _, call := range []struct{ name, names string }{
		{"probe_binary", "install.Deps.Run"},
		{"npm_global_dirs", "install.Deps.OS"},
		{"host_artifact_target", "install.Deps.OS"},
		{"theme_install", "install.Deps.Home"},
	} {
		args := arguments(t, map[string]any{"bin": "/opt/bin/node", "path": "/somewhere/x.json"})
		_, err := registry.Invoke(call.name, args)
		if err == nil {
			t.Errorf("%s answered with nothing wired", call.name)
			continue
		}
		if !strings.Contains(err.Error(), call.names) {
			t.Errorf("%s: the refusal does not name what to supply: %v", call.name, err)
		}
	}
}
