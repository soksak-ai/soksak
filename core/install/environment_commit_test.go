package install

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	coreenvironment "github.com/soksak-ai/soksak-core/core/environment"
)

func TestSidecarCommitRefusesWhenProjectNameWasNotInjected(t *testing.T) {
	home := t.TempDir()
	archive := tgz(t,
		archiveEntry{name: "sidecar.json", body: `{"id":"soksak-sidecar-pty","version":"0.0.1","processRole":"sidecar-pty","interface":[{"id":"soksak-spec-sidecar-pty","version":"0.0.1"}],"process":"dist/soksak-sidecar-pty"}`},
		archiveEntry{name: "dist/soksak-sidecar-pty", body: "binary"},
	)
	manager := NewTransactionManager(filepath.Join(home, ".transactions"), memoryFetcher{body: archive}, nil)
	identity := ArtifactIdentity{Kind: "sidecar", ID: "soksak-sidecar-pty", Version: "0.0.1"}
	transaction, err := manager.Begin("official", identity)
	if err != nil {
		t.Fatal(err)
	}
	staged, err := manager.Stage(context.Background(), StageRequest{
		TransactionID: transaction.TransactionID,
		RegistryID:    "official",
		Identity:      identity,
		Artifact: Artifact{
			File: "soksak-sidecar-pty.tgz", Size: uint64(len(archive)), SHA256: sha256Hex(archive),
			Format: "tgz", Manifest: "sidecar.json", Entrypoints: []string{"sidecar.json", "dist/soksak-sidecar-pty"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = manager.Commit(CommitRequest{
		TransactionID: transaction.TransactionID, ExpectedRevision: 0, Home: home,
		Components: []VerifiedComponent{{
			Kind: "sidecar", ID: identity.ID, Version: identity.Version, Target: "aarch64-apple-darwin",
			RegistryID: "official", SourceRepository: "https://github.com/soksak-ai/soksak-sidecar-pty",
			SourceCommit: strings.Repeat("a", 40), ArtifactSHA256: staged.SHA256, StagedHandle: staged.Handle,
		}},
	})
	if err == nil || !strings.Contains(err.Error(), "install transaction needs the declared project name") {
		t.Fatalf("error=%v", err)
	}
}

func TestSidecarCommitMaterializesTheDeclaredProjectProcess(t *testing.T) {
	home := t.TempDir()
	archive := tgz(t,
		archiveEntry{name: "sidecar.json", body: `{"id":"soksak-sidecar-terminal-alacritty","version":"0.0.1","processRole":"sidecar-terminal-alacritty","interface":[{"id":"soksak-spec-sidecar-terminal","version":"0.0.1"}],"process":"dist/soksak-sidecar-terminal-alacritty"}`},
		archiveEntry{name: "dist/soksak-sidecar-terminal-alacritty", body: "binary"},
	)
	manager := NewTransactionManager(filepath.Join(home, ".transactions"), memoryFetcher{body: archive}, nil)
	identity := ArtifactIdentity{Kind: "sidecar", ID: "soksak-sidecar-terminal-alacritty", Version: "0.0.1"}
	transaction, err := manager.Begin("official", identity)
	if err != nil {
		t.Fatal(err)
	}
	staged, err := manager.Stage(context.Background(), StageRequest{
		TransactionID: transaction.TransactionID, RegistryID: "official", Identity: identity,
		Artifact: Artifact{
			File: "alacritty.tgz", Size: uint64(len(archive)), SHA256: sha256Hex(archive), Format: "tgz",
			Manifest: "sidecar.json", Entrypoints: []string{"sidecar.json", "dist/soksak-sidecar-terminal-alacritty"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = manager.Commit(CommitRequest{
		TransactionID: transaction.TransactionID, ExpectedRevision: 0, Home: home, Project: "soksakv3",
		Components: []VerifiedComponent{{
			Kind: "sidecar", ID: identity.ID, Version: identity.Version, Target: "aarch64-apple-darwin",
			RegistryID: "official", SourceRepository: "https://github.com/soksak-ai/soksak-sidecar-terminal-alacritty",
			SourceCommit: strings.Repeat("a", 40), ArtifactSHA256: staged.SHA256, StagedHandle: staged.Handle,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	environment, exists, err := coreenvironment.Read(home)
	if err != nil || !exists {
		t.Fatalf("environment exists=%v err=%v", exists, err)
	}
	record := environment.Sidecars[identity.ID]
	want := filepath.Join(record.Path, "dist", "soksakv3-sidecar-terminal-alacritty")
	if record.Process != want {
		t.Fatalf("process=%q want=%q", record.Process, want)
	}
	if body, err := os.ReadFile(want); err != nil || string(body) != "binary" {
		t.Fatalf("materialized process body=%q err=%v", body, err)
	}
	if _, err := os.Lstat(filepath.Join(record.Path, "dist", "soksak-sidecar-terminal-alacritty")); !os.IsNotExist(err) {
		t.Fatalf("canonical artifact process remained after materialization: %v", err)
	}
}

func TestCommitPublishesOneEnvironmentWithSeparateComponentPaths(t *testing.T) {
	home := t.TempDir()
	manager := NewTransactionManager(filepath.Join(home, ".transactions"), memoryFetcher{}, nil)
	root := ArtifactIdentity{Kind: "plugin", ID: "view", Version: "0.0.1"}
	transaction, _ := manager.Begin("official", root)
	pluginArchive := tgz(t, archiveEntry{name: "plugin.json", body: `{"id":"view","version":"0.0.1"}`})
	sidecarArchive := tgz(t,
		archiveEntry{name: "sidecar.json", body: `{"id":"state","version":"0.0.1","processRole":"sidecar-state","interface":[{"id":"state","version":"0.0.1"}],"process":"dist/state"}`},
		archiveEntry{name: "dist/state", body: "binary"},
	)
	manager.fetcher = memoryFetcher{body: pluginArchive}
	pluginStage, err := manager.Stage(context.Background(), StageRequest{TransactionID: transaction.TransactionID, RegistryID: "official", Identity: root, Artifact: Artifact{File: "p.tgz", Size: uint64(len(pluginArchive)), SHA256: sha256Hex(pluginArchive), Format: "tgz", Manifest: "plugin.json", Entrypoints: []string{"plugin.json"}}})
	if err != nil {
		t.Fatal(err)
	}
	sidecarIdentity := ArtifactIdentity{Kind: "sidecar", ID: "state", Version: "0.0.1"}
	manager.fetcher = memoryFetcher{body: sidecarArchive}
	sidecarStage, err := manager.Stage(context.Background(), StageRequest{TransactionID: transaction.TransactionID, RegistryID: "official", Identity: sidecarIdentity, Artifact: Artifact{File: "s.tgz", Size: uint64(len(sidecarArchive)), SHA256: sha256Hex(sidecarArchive), Format: "tgz", Manifest: "sidecar.json", Entrypoints: []string{"sidecar.json", "dist/state"}}})
	if err != nil {
		t.Fatal(err)
	}
	commit := "0123456789abcdef0123456789abcdef01234567"
	result, err := manager.Commit(CommitRequest{
		TransactionID: transaction.TransactionID, ExpectedRevision: 0,
		Components: []VerifiedComponent{
			{Kind: "plugin", ID: "view", Version: "0.0.1", RegistryID: "official", SourceRepository: "https://github.com/example/view", SourceCommit: commit, ArtifactSHA256: pluginStage.SHA256, StagedHandle: pluginStage.Handle},
			{Kind: "sidecar", ID: "state", Version: "0.0.1", Target: "aarch64-apple-darwin", RegistryID: "official", SourceRepository: "https://github.com/example/state", SourceCommit: commit, ArtifactSHA256: sidecarStage.SHA256, StagedHandle: sidecarStage.Handle},
		}, Home: home, Project: "soksakv3",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Revision != 1 {
		t.Fatalf("result=%+v", result)
	}
	body, err := os.ReadFile(filepath.Join(home, coreenvironment.File))
	if err != nil {
		t.Fatal(err)
	}
	environment, err := coreenvironment.Parse(body)
	if err != nil {
		t.Fatal(err)
	}
	if len(environment.Plugins) != 1 || len(environment.Sidecars) != 1 {
		t.Fatalf("environment=%+v", environment)
	}
	if environment.Plugins["view"].ArtifactSHA256 != pluginStage.SHA256 || environment.Sidecars["state"].ArtifactSHA256 != sidecarStage.SHA256 {
		t.Fatalf("environment did not record installed artifact identity: %+v", environment)
	}
	if environment.Plugins["view"].Path == environment.Sidecars["state"].Path {
		t.Fatalf("plugin and sidecar share install path: %s", environment.Plugins["view"].Path)
	}
	for _, path := range []string{environment.Plugins["view"].Path, environment.Sidecars["state"].Path} {
		if info, err := os.Stat(path); err != nil || !info.IsDir() {
			t.Fatalf("published path %s: info=%v err=%v", path, info, err)
		}
	}
}

func TestCommitReplacesALocalRecordWithAnExplicitRegistryInstall(t *testing.T) {
	home := t.TempDir()
	current := coreenvironment.Empty()
	current.Plugins["view"] = coreenvironment.Plugin{Component: coreenvironment.Component{
		Version: "0.0.1", Path: filepath.Join(home, "old"), ArtifactSHA256: strings.Repeat("a", 64),
		Source: "local",
	}}
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	writeJSONFile(t, filepath.Join(home, coreenvironment.File), current)
	archive := tgz(t, archiveEntry{name: "plugin.json", body: `{"id":"view","version":"0.0.1"}`})
	manager := NewTransactionManager(filepath.Join(home, ".transactions"), memoryFetcher{body: archive}, nil)
	identity := ArtifactIdentity{Kind: "plugin", ID: "view", Version: "0.0.1"}
	transaction, err := manager.Begin("official", identity)
	if err != nil {
		t.Fatal(err)
	}
	staged, err := manager.Stage(context.Background(), StageRequest{TransactionID: transaction.TransactionID, RegistryID: "official", Identity: identity, Artifact: Artifact{File: "view.tgz", Size: uint64(len(archive)), SHA256: sha256Hex(archive), Format: "tgz", Manifest: "plugin.json", Entrypoints: []string{"plugin.json"}}})
	if err != nil {
		t.Fatal(err)
	}
	// The frontend gates the explicit request; the commit replaces the local development slot.
	result, err := manager.Commit(CommitRequest{TransactionID: transaction.TransactionID, ExpectedRevision: 1, Home: home, Components: []VerifiedComponent{{Kind: "plugin", ID: "view", Version: "0.0.1", RegistryID: "official", ArtifactSHA256: staged.SHA256, StagedHandle: staged.Handle}}})
	if err != nil {
		t.Fatal(err)
	}
	if result.Revision != 2 {
		t.Fatalf("result=%+v", result)
	}
	after, _, err := coreenvironment.Read(home)
	if err != nil {
		t.Fatal(err)
	}
	record := after.Plugins["view"]
	if record.Source != "registry" || record.ArtifactSHA256 != staged.SHA256 {
		t.Fatalf("record = %+v", record)
	}
}

func TestCommitRefusesAnInstallOverARegistryRecordWithDifferentBytes(t *testing.T) {
	home := t.TempDir()
	current := coreenvironment.Empty()
	current.Plugins["view"] = coreenvironment.Plugin{Component: coreenvironment.Component{
		Version: "0.0.1", Path: filepath.Join(home, "old"), ArtifactSHA256: strings.Repeat("a", 64),
		Source: "registry", Registry: "official",
	}}
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	writeJSONFile(t, filepath.Join(home, coreenvironment.File), current)
	archive := tgz(t, archiveEntry{name: "plugin.json", body: `{"id":"view","version":"0.0.1"}`})
	manager := NewTransactionManager(filepath.Join(home, ".transactions"), memoryFetcher{body: archive}, nil)
	identity := ArtifactIdentity{Kind: "plugin", ID: "view", Version: "0.0.1"}
	transaction, err := manager.Begin("official", identity)
	if err != nil {
		t.Fatal(err)
	}
	staged, err := manager.Stage(context.Background(), StageRequest{TransactionID: transaction.TransactionID, RegistryID: "official", Identity: identity, Artifact: Artifact{File: "view.tgz", Size: uint64(len(archive)), SHA256: sha256Hex(archive), Format: "tgz", Manifest: "plugin.json", Entrypoints: []string{"plugin.json"}}})
	if err != nil {
		t.Fatal(err)
	}
	_, err = manager.Commit(CommitRequest{TransactionID: transaction.TransactionID, ExpectedRevision: 1, Home: home, Components: []VerifiedComponent{{Kind: "plugin", ID: "view", Version: "0.0.1", RegistryID: "official", ArtifactSHA256: staged.SHA256, StagedHandle: staged.Handle}}})
	if err == nil || !strings.Contains(err.Error(), "VERSION_ARTIFACT_CONFLICT") || !strings.Contains(err.Error(), staged.SHA256) {
		t.Fatalf("error = %v", err)
	}
}

func TestCommitRejectsASidecarVersionThatBreaksAnInstalledPlugin(t *testing.T) {
	home := t.TempDir()
	pluginRoot := t.TempDir()
	writeJSONFile(t, filepath.Join(pluginRoot, "plugin.json"), map[string]any{
		"id": "terminal", "version": "0.0.23",
		"runtimeDependencies": map[string]any{"sidecars": []map[string]any{{"id": "terminal-state", "version": "0.0.12"}}},
	})
	current := coreenvironment.Empty()
	current.Plugins["terminal"] = coreenvironment.Plugin{Component: coreenvironment.Component{
		Version: "0.0.23", Path: pluginRoot, ArtifactSHA256: strings.Repeat("a", 64), Source: "local",
	}}
	oldSidecarRoot := t.TempDir()
	current.Sidecars["terminal-state"] = coreenvironment.Component{
		Version: "0.0.12", Path: oldSidecarRoot, Process: filepath.Join(oldSidecarRoot, "dist", "soksakv3-sidecar-terminal-state"), ArtifactSHA256: strings.Repeat("b", 64), Source: "registry", Registry: "official", Target: "aarch64-apple-darwin",
	}
	writeJSONFile(t, filepath.Join(home, coreenvironment.File), current)

	archive := tgz(t,
		archiveEntry{name: "sidecar.json", body: `{"id":"terminal-state","version":"0.0.13","processRole":"sidecar-terminal-state","interface":[{"id":"terminal-state","version":"0.0.1"}],"process":"dist/terminal-state"}`},
		archiveEntry{name: "dist/terminal-state", body: "binary"},
	)
	manager := NewTransactionManager(filepath.Join(home, ".transactions"), memoryFetcher{body: archive}, nil)
	identity := ArtifactIdentity{Kind: "sidecar", ID: "terminal-state", Version: "0.0.13"}
	transaction, err := manager.Begin("official", identity)
	if err != nil {
		t.Fatal(err)
	}
	staged, err := manager.Stage(context.Background(), StageRequest{TransactionID: transaction.TransactionID, RegistryID: "official", Identity: identity, Artifact: Artifact{File: "state.tgz", Size: uint64(len(archive)), SHA256: sha256Hex(archive), Format: "tgz", Manifest: "sidecar.json", Entrypoints: []string{"sidecar.json", "dist/terminal-state"}}})
	if err != nil {
		t.Fatal(err)
	}
	_, err = manager.Commit(CommitRequest{TransactionID: transaction.TransactionID, ExpectedRevision: 1, Home: home, Project: "soksakv3", Components: []VerifiedComponent{{Kind: "sidecar", ID: "terminal-state", Version: "0.0.13", Target: "aarch64-apple-darwin", RegistryID: "official", ArtifactSHA256: staged.SHA256, StagedHandle: staged.Handle}}})
	if err == nil || !strings.Contains(err.Error(), "DEPENDENCY_VERSION_CONFLICT") || !strings.Contains(err.Error(), "terminal@0.0.23") || !strings.Contains(err.Error(), "0.0.12") || !strings.Contains(err.Error(), "0.0.13") {
		t.Fatalf("error = %v", err)
	}
	after, _, readErr := coreenvironment.Read(home)
	if readErr != nil || after.Sidecars["terminal-state"].Version != "0.0.12" {
		t.Fatalf("environment changed after conflict: %+v err=%v", after, readErr)
	}
}

func TestCommitReplacesADevelopmentRecordOfTheSameVersion(t *testing.T) {
	home := t.TempDir()
	source := t.TempDir()
	writeJSONFile(t, filepath.Join(source, "plugin.json"), map[string]any{"id": "view", "version": "0.0.1"})
	current := coreenvironment.Empty()
	current.Plugins["view"] = coreenvironment.Plugin{Component: coreenvironment.Component{Version: "0.0.1", Path: source, Source: "development"}, Enabled: true}
	writeJSONFile(t, filepath.Join(home, coreenvironment.File), current)
	archive := tgz(t, archiveEntry{name: "plugin.json", body: `{"id":"view","version":"0.0.1"}`})
	manager := NewTransactionManager(filepath.Join(home, ".transactions"), memoryFetcher{body: archive}, nil)
	identity := ArtifactIdentity{Kind: "plugin", ID: "view", Version: "0.0.1"}
	transaction, err := manager.Begin("official", identity)
	if err != nil {
		t.Fatal(err)
	}
	staged, err := manager.Stage(context.Background(), StageRequest{TransactionID: transaction.TransactionID, RegistryID: "official", Identity: identity, Artifact: Artifact{File: "view.tgz", Size: uint64(len(archive)), SHA256: sha256Hex(archive), Format: "tgz", Manifest: "plugin.json", Entrypoints: []string{"plugin.json"}}})
	if err != nil {
		t.Fatal(err)
	}
	result, err := manager.Commit(CommitRequest{TransactionID: transaction.TransactionID, ExpectedRevision: 1, Home: home, Components: []VerifiedComponent{{Kind: "plugin", ID: "view", Version: "0.0.1", RegistryID: "official", ArtifactSHA256: staged.SHA256, StagedHandle: staged.Handle}}})
	if err != nil {
		t.Fatal(err)
	}
	if result.Revision != 2 {
		t.Fatalf("result=%+v", result)
	}
	after, _, err := coreenvironment.Read(home)
	if err != nil {
		t.Fatal(err)
	}
	record := after.Plugins["view"]
	if record.Source != "registry" || record.Registry != "official" || record.ArtifactSHA256 != staged.SHA256 || !record.Enabled {
		t.Fatalf("record=%+v", record)
	}
	if record.Path == source || !strings.HasPrefix(record.Path, filepath.Join(home, "components")) {
		t.Fatalf("record path=%s", record.Path)
	}
	if _, err := os.Stat(filepath.Join(source, "plugin.json")); err != nil {
		t.Fatalf("development source directory was touched: %v", err)
	}
}

// stageViewArchive stages plugin view@0.0.1 and returns the manager, transaction id and staged artifact.
func stageViewArchive(t *testing.T, home string) (*TransactionManager, string, StagedArtifact) {
	t.Helper()
	archive := tgz(t, archiveEntry{name: "plugin.json", body: `{"id":"view","version":"0.0.1"}`})
	manager := NewTransactionManager(filepath.Join(home, ".transactions"), memoryFetcher{body: archive}, nil)
	identity := ArtifactIdentity{Kind: "plugin", ID: "view", Version: "0.0.1"}
	transaction, err := manager.Begin("official", identity)
	if err != nil {
		t.Fatal(err)
	}
	staged, err := manager.Stage(context.Background(), StageRequest{TransactionID: transaction.TransactionID, RegistryID: "official", Identity: identity, Artifact: Artifact{File: "view.tgz", Size: uint64(len(archive)), SHA256: sha256Hex(archive), Format: "tgz", Manifest: "plugin.json", Entrypoints: []string{"plugin.json"}}})
	if err != nil {
		t.Fatal(err)
	}
	return manager, transaction.TransactionID, staged
}

// presentArtifactDirectory creates the content-addressed directory for view@0.0.1 with a marker file.
func presentArtifactDirectory(t *testing.T, home, digest string) string {
	t.Helper()
	final := filepath.Join(home, "components", "plugin", "view", "0.0.1", digest)
	if err := os.MkdirAll(final, 0o755); err != nil {
		t.Fatal(err)
	}
	writeJSONFile(t, filepath.Join(final, "plugin.json"), map[string]any{"id": "view", "version": "0.0.1"})
	if err := os.WriteFile(filepath.Join(final, "marker"), []byte("present"), 0o600); err != nil {
		t.Fatal(err)
	}
	return final
}

func assertReusedDirectory(t *testing.T, home, final, digest, stagedPath string, revision uint64) {
	t.Helper()
	after, _, err := coreenvironment.Read(home)
	if err != nil || after.Revision != revision {
		t.Fatalf("environment=%+v err=%v", after, err)
	}
	record := after.Plugins["view"]
	if record.Path != final || record.Source != "registry" || record.Registry != "official" || record.ArtifactSHA256 != digest {
		t.Fatalf("record=%+v", record)
	}
	if _, err := os.Stat(filepath.Join(final, "marker")); err != nil {
		t.Fatalf("existing directory was replaced: %v", err)
	}
	if _, err := os.Lstat(stagedPath); !os.IsNotExist(err) {
		t.Fatalf("staged copy remains: err=%v", err)
	}
}

func TestCommitReusesAnExistingArtifactDirectoryOverADevelopmentRecord(t *testing.T) {
	home := t.TempDir()
	source := t.TempDir()
	writeJSONFile(t, filepath.Join(source, "plugin.json"), map[string]any{"id": "view", "version": "0.0.1"})
	current := coreenvironment.Empty()
	current.Plugins["view"] = coreenvironment.Plugin{Component: coreenvironment.Component{Version: "0.0.1", Path: source, Source: "development"}, Enabled: true}
	writeJSONFile(t, filepath.Join(home, coreenvironment.File), current)
	manager, transactionID, staged := stageViewArchive(t, home)
	final := presentArtifactDirectory(t, home, staged.SHA256)
	stagedPath := filepath.Join(manager.root, transactionID, staged.Handle)
	result, err := manager.Commit(CommitRequest{TransactionID: transactionID, ExpectedRevision: 1, Home: home, Components: []VerifiedComponent{{Kind: "plugin", ID: "view", Version: "0.0.1", RegistryID: "official", ArtifactSHA256: staged.SHA256, StagedHandle: staged.Handle}}})
	if err != nil {
		t.Fatal(err)
	}
	if result.Revision != 2 {
		t.Fatalf("result=%+v", result)
	}
	assertReusedDirectory(t, home, final, staged.SHA256, stagedPath, 2)
	if _, err := os.Stat(filepath.Join(source, "plugin.json")); err != nil {
		t.Fatalf("development source directory was touched: %v", err)
	}
}

func TestCommitReusesAnExistingArtifactDirectoryWithoutARecord(t *testing.T) {
	home := t.TempDir()
	writeJSONFile(t, filepath.Join(home, coreenvironment.File), coreenvironment.Empty())
	manager, transactionID, staged := stageViewArchive(t, home)
	final := presentArtifactDirectory(t, home, staged.SHA256)
	stagedPath := filepath.Join(manager.root, transactionID, staged.Handle)
	result, err := manager.Commit(CommitRequest{TransactionID: transactionID, ExpectedRevision: 1, Home: home, Components: []VerifiedComponent{{Kind: "plugin", ID: "view", Version: "0.0.1", RegistryID: "official", ArtifactSHA256: staged.SHA256, StagedHandle: staged.Handle}}})
	if err != nil {
		t.Fatal(err)
	}
	if result.Revision != 2 {
		t.Fatalf("result=%+v", result)
	}
	assertReusedDirectory(t, home, final, staged.SHA256, stagedPath, 2)
}

func TestCommitProceedsWhileAnUnrelatedDevelopmentRecordIsBroken(t *testing.T) {
	home := t.TempDir()
	source := filepath.Join(t.TempDir(), "gone")
	current := coreenvironment.Empty()
	// The development directory of base was deleted after develop; view does not depend on it.
	current.Plugins["base"] = coreenvironment.Plugin{Component: coreenvironment.Component{Version: "1.0.0", Path: source, Source: "development"}, Enabled: true}
	writeJSONFile(t, filepath.Join(home, coreenvironment.File), current)
	manager, transactionID, staged := stageViewArchive(t, home)
	result, err := manager.Commit(CommitRequest{TransactionID: transactionID, ExpectedRevision: 1, Home: home, Components: []VerifiedComponent{{Kind: "plugin", ID: "view", Version: "0.0.1", RegistryID: "official", ArtifactSHA256: staged.SHA256, StagedHandle: staged.Handle}}})
	if err != nil {
		t.Fatal(err)
	}
	if result.Revision != 2 {
		t.Fatalf("result=%+v", result)
	}
	after, _, err := coreenvironment.Read(home)
	if err != nil || after.Plugins["view"].Source != "registry" || after.Plugins["base"].Path != source {
		t.Fatalf("environment=%+v err=%v", after, err)
	}
}

func TestCommitReplacesALocalRecordWithALocalInstallOfTheSameVersion(t *testing.T) {
	home := t.TempDir()
	store := t.TempDir()
	archive := tgz(t, archiveEntry{name: "plugin.json", body: `{"id":"view","version":"0.0.1"}`}, archiveEntry{name: "main.js", body: "export default {}"})
	directory := filepath.Join(store, "plugins", "view", "0.0.1")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "view-0.0.1.tgz"), archive, 0o600); err != nil {
		t.Fatal(err)
	}
	current := coreenvironment.Empty()
	current.Plugins["view"] = coreenvironment.Plugin{Component: coreenvironment.Component{
		Version: "0.0.1", Path: filepath.Join(home, "old"), ArtifactSHA256: strings.Repeat("a", 64), Source: "local",
	}, Enabled: true}
	writeJSONFile(t, filepath.Join(home, coreenvironment.File), current)
	manager := NewTransactionManager(filepath.Join(home, ".transactions"), memoryFetcher{err: context.Canceled}, nil)
	identity := ArtifactIdentity{Kind: "plugin", ID: "view", Version: "0.0.1"}
	transaction, err := manager.Begin("local", identity, store)
	if err != nil {
		t.Fatal(err)
	}
	staged, err := manager.Stage(context.Background(), StageRequest{TransactionID: transaction.TransactionID, RegistryID: "local", Identity: identity, Artifact: Artifact{File: "view-0.0.1.tgz", Size: uint64(len(archive)), SHA256: sha256Hex(archive), Format: "tgz", Manifest: "plugin.json", Entrypoints: []string{"plugin.json"}}})
	if err != nil {
		t.Fatal(err)
	}
	result, err := manager.Commit(CommitRequest{TransactionID: transaction.TransactionID, ExpectedRevision: 1, Home: home, Components: []VerifiedComponent{{Kind: "plugin", ID: "view", Version: "0.0.1", RegistryID: "local", ArtifactSHA256: staged.SHA256, StagedHandle: staged.Handle}}})
	if err != nil {
		t.Fatalf("local install did not replace the local record: %v", err)
	}
	if result.Revision != 2 {
		t.Fatalf("result=%+v", result)
	}
	after, _, err := coreenvironment.Read(home)
	if err != nil {
		t.Fatal(err)
	}
	record := after.Plugins["view"]
	if record.Source != "local" || record.Registry != "" || record.ArtifactSHA256 != staged.SHA256 || !record.Enabled {
		t.Fatalf("record=%+v", record)
	}
	if !strings.HasPrefix(record.Path, filepath.Join(home, "components")) || !strings.HasSuffix(record.Path, staged.SHA256) {
		t.Fatalf("record path=%s", record.Path)
	}
}
