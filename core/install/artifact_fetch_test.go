package install

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLocalTransactionReadsOnlyTheAddressedReleaseAsset(t *testing.T) {
	store := t.TempDir()
	archive := tgz(t, archiveEntry{name: "plugin.json", body: `{"id":"view","version":"0.0.1"}`})
	directory := filepath.Join(store, "plugins", "view", "0.0.1")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "view.tgz"), archive, 0o600); err != nil {
		t.Fatal(err)
	}
	manager := NewTransactionManager(t.TempDir(), memoryFetcher{err: context.Canceled}, nil)
	identity := ArtifactIdentity{Kind: "plugin", ID: "view", Version: "0.0.1"}
	transaction, err := manager.Begin("local", identity, store)
	if err != nil {
		t.Fatal(err)
	}
	_, err = manager.Stage(context.Background(), StageRequest{TransactionID: transaction.TransactionID, RegistryID: "local", Identity: identity, Artifact: Artifact{URL: "https://github.com/example/view/releases/download/v0.0.1/view.tgz", Size: uint64(len(archive)), SHA256: sha256Hex(archive), Format: "tgz", Manifest: "plugin.json", Entrypoints: []string{"plugin.json"}}})
	if err != nil {
		t.Fatalf("local stage used the remote fetcher: %v", err)
	}
}

func TestLocalTransactionNeverFallsBackWhenTheReleaseIsMissing(t *testing.T) {
	manager := NewTransactionManager(t.TempDir(), memoryFetcher{body: []byte("remote bytes")}, nil)
	identity := ArtifactIdentity{Kind: "plugin", ID: "view", Version: "0.0.1"}
	transaction, err := manager.Begin("local", identity, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	_, err = manager.Stage(context.Background(), StageRequest{TransactionID: transaction.TransactionID, RegistryID: "local", Identity: identity, Artifact: Artifact{URL: "https://github.com/example/view/releases/download/v0.0.1/view.tgz", Size: 12, SHA256: strings.Repeat("a", 64), Format: "tgz", Manifest: "plugin.json", Entrypoints: []string{"plugin.json"}}})
	if err == nil || !strings.Contains(err.Error(), "local release is missing") {
		t.Fatalf("error = %v", err)
	}
}

func TestLocalTransactionUsesHTTPSForAnAbsentDependency(t *testing.T) {
	store := t.TempDir()
	rootDirectory := filepath.Join(store, "plugins", "root", "0.0.1")
	if err := os.MkdirAll(rootDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	archive := tgz(t, archiveEntry{name: "sidecar.json", body: `{"id":"state","version":"0.0.1"}`})
	manager := NewTransactionManager(t.TempDir(), memoryFetcher{body: archive}, nil)
	root := ArtifactIdentity{Kind: "plugin", ID: "root", Version: "0.0.1"}
	transaction, err := manager.Begin("local", root, store)
	if err != nil {
		t.Fatal(err)
	}
	identity := ArtifactIdentity{Kind: "sidecar", ID: "state", Version: "0.0.1"}
	_, err = manager.Stage(context.Background(), StageRequest{TransactionID: transaction.TransactionID, RegistryID: "local", Identity: identity, Artifact: Artifact{URL: "https://github.com/example/state/releases/download/v0.0.1/state.tgz", Size: uint64(len(archive)), SHA256: sha256Hex(archive), Format: "tgz", Manifest: "sidecar.json", Entrypoints: []string{"sidecar.json"}}})
	if err != nil {
		t.Fatalf("absent local dependency did not use HTTPS transport: %v", err)
	}
}
