package install

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	coreenvironment "github.com/soksak-ai/soksak-core/core/environment"
)

func TestCommitPublishesOneEnvironmentWithSeparateComponentPaths(t *testing.T) {
	home := t.TempDir()
	manager := NewTransactionManager(filepath.Join(home, ".transactions"), memoryFetcher{}, nil)
	root := ArtifactIdentity{Kind: "plugin", ID: "view", Version: "0.0.1"}
	transaction, _ := manager.Begin("official", root)
	pluginArchive := tgz(t, archiveEntry{name: "plugin.json", body: `{"id":"view","version":"0.0.1"}`})
	sidecarArchive := tgz(t, archiveEntry{name: "sidecar.json", body: `{"id":"state","version":"0.0.1"}`})
	manager.fetcher = memoryFetcher{body: pluginArchive}
	pluginStage, err := manager.Stage(context.Background(), StageRequest{TransactionID: transaction.TransactionID, RegistryID: "official", Identity: root, Artifact: Artifact{URL: "https://example.invalid/p.tgz", Size: uint64(len(pluginArchive)), SHA256: sha256Hex(pluginArchive), Format: "tgz", Manifest: "plugin.json", Entrypoints: []string{"plugin.json"}}})
	if err != nil {
		t.Fatal(err)
	}
	sidecarIdentity := ArtifactIdentity{Kind: "sidecar", ID: "state", Version: "0.0.1"}
	manager.fetcher = memoryFetcher{body: sidecarArchive}
	sidecarStage, err := manager.Stage(context.Background(), StageRequest{TransactionID: transaction.TransactionID, RegistryID: "official", Identity: sidecarIdentity, Artifact: Artifact{URL: "https://example.invalid/s.tgz", Size: uint64(len(sidecarArchive)), SHA256: sha256Hex(sidecarArchive), Format: "tgz", Manifest: "sidecar.json", Entrypoints: []string{"sidecar.json"}}})
	if err != nil {
		t.Fatal(err)
	}
	commit := "0123456789abcdef0123456789abcdef01234567"
	result, err := manager.Commit(CommitRequest{
		TransactionID: transaction.TransactionID, ExpectedRevision: 0,
		Components: []VerifiedComponent{
			{Kind: "plugin", ID: "view", Version: "0.0.1", RegistryID: "official", SourceRepository: "https://github.com/example/view", SourceCommit: commit, ArtifactURL: "https://example.invalid/p.tgz", ArtifactSHA256: pluginStage.SHA256, StagedHandle: pluginStage.Handle},
			{Kind: "sidecar", ID: "state", Version: "0.0.1", Target: "aarch64-apple-darwin", RegistryID: "official", SourceRepository: "https://github.com/example/state", SourceCommit: commit, ArtifactURL: "https://example.invalid/s.tgz", ArtifactSHA256: sidecarStage.SHA256, StagedHandle: sidecarStage.Handle},
		}, Home: home,
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

func TestCommitRejectsDifferentBytesAtOneInstalledVersion(t *testing.T) {
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
	staged, err := manager.Stage(context.Background(), StageRequest{TransactionID: transaction.TransactionID, RegistryID: "official", Identity: identity, Artifact: Artifact{URL: "https://example.invalid/view.tgz", Size: uint64(len(archive)), SHA256: sha256Hex(archive), Format: "tgz", Manifest: "plugin.json", Entrypoints: []string{"plugin.json"}}})
	if err != nil {
		t.Fatal(err)
	}
	_, err = manager.Commit(CommitRequest{TransactionID: transaction.TransactionID, ExpectedRevision: 1, Home: home, Components: []VerifiedComponent{{Kind: "plugin", ID: "view", Version: "0.0.1", RegistryID: "official", ArtifactURL: "https://example.invalid/view.tgz", ArtifactSHA256: staged.SHA256, StagedHandle: staged.Handle}}})
	if err == nil || !strings.Contains(err.Error(), "VERSION_ARTIFACT_CONFLICT") || !strings.Contains(err.Error(), staged.SHA256) {
		t.Fatalf("error = %v", err)
	}
}
