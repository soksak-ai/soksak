package install

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type memoryFetcher struct {
	body []byte
	err  error
}

func (fetcher memoryFetcher) Fetch(context.Context, string) ([]byte, error) {
	return fetcher.body, fetcher.err
}

type archiveEntry struct {
	name, body string
	kind       byte
	link       string
}

func tgz(t *testing.T, entries ...archiveEntry) []byte {
	t.Helper()
	var output bytes.Buffer
	gzipWriter := gzip.NewWriter(&output)
	tarWriter := tar.NewWriter(gzipWriter)
	for _, entry := range entries {
		header := &tar.Header{Name: entry.name, Mode: 0o644, Size: int64(len(entry.body)), Typeflag: entry.kind, Linkname: entry.link}
		if entry.kind == 0 {
			header.Typeflag = tar.TypeReg
		}
		if err := tarWriter.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if header.Typeflag == tar.TypeReg {
			if _, err := tarWriter.Write([]byte(entry.body)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tarWriter.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gzipWriter.Close(); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

func TestTransactionStagesAndReadsARegularFileArchive(t *testing.T) {
	archive := tgz(t, archiveEntry{name: "plugin.json", body: "{\"id\":\"demo\"}"}, archiveEntry{name: "main.js", body: "export default {}"})
	manager := NewTransactionManager(t.TempDir(), memoryFetcher{body: archive})
	transaction, err := manager.Begin("official", UnitIdentity{Kind: "plugin", ID: "demo", Version: "0.0.1"})
	if err != nil {
		t.Fatal(err)
	}
	staged, err := manager.Stage(context.Background(), StageRequest{
		TransactionID: transaction.TransactionID, RegistryID: "official",
		Unit:     UnitIdentity{Kind: "plugin", ID: "demo", Version: "0.0.1"},
		Artifact: Artifact{URL: "https://example.invalid/demo.tgz", SHA256: sha256Hex(archive), Format: "tgz", Entrypoints: []string{"plugin.json"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if staged.Extraction != "regular-files-only" || len(staged.VerifiedEntrypoints) != 1 {
		t.Fatalf("staged = %+v", staged)
	}
	text, err := manager.ReadUTF8(transaction.TransactionID, staged.Handle, "plugin.json")
	if err != nil || text != "{\"id\":\"demo\"}" {
		t.Fatalf("text=%q err=%v", text, err)
	}
	if err := manager.Rollback(transaction.TransactionID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(manager.root, transaction.TransactionID)); !os.IsNotExist(err) {
		t.Fatalf("staging remains: %v", err)
	}
}

func TestStageRejectsDigestMismatch(t *testing.T) {
	archive := tgz(t, archiveEntry{name: "plugin.json", body: "{}"})
	manager := NewTransactionManager(t.TempDir(), memoryFetcher{body: archive})
	transaction, _ := manager.Begin("official", UnitIdentity{Kind: "plugin", ID: "demo", Version: "0.0.1"})
	_, err := manager.Stage(context.Background(), StageRequest{TransactionID: transaction.TransactionID, RegistryID: "official", Unit: UnitIdentity{Kind: "plugin", ID: "demo", Version: "0.0.1"}, Artifact: Artifact{URL: "https://example.invalid/a.tgz", SHA256: strings.Repeat("0", 64), Format: "tgz", Entrypoints: []string{"plugin.json"}}})
	if err == nil || !strings.Contains(err.Error(), "SHA-256") {
		t.Fatalf("error = %v", err)
	}
}

func TestStageRejectsLinksAndPathEscape(t *testing.T) {
	archives := [][]byte{
		tgz(t, archiveEntry{name: "plugin.json", kind: tar.TypeSymlink, link: "elsewhere"}),
		tgz(t, archiveEntry{name: "../plugin.json", body: "{}"}),
	}
	for _, archive := range archives {
		manager := NewTransactionManager(t.TempDir(), memoryFetcher{body: archive})
		transaction, _ := manager.Begin("official", UnitIdentity{Kind: "plugin", ID: "demo", Version: "0.0.1"})
		_, err := manager.Stage(context.Background(), StageRequest{TransactionID: transaction.TransactionID, RegistryID: "official", Unit: UnitIdentity{Kind: "plugin", ID: "demo", Version: "0.0.1"}, Artifact: Artifact{URL: "https://example.invalid/a.tgz", SHA256: sha256Hex(archive), Format: "tgz", Entrypoints: []string{"plugin.json"}}})
		if err == nil {
			t.Fatal("unsafe archive was accepted")
		}
	}
}

func TestStageRequiresEveryDeclaredEntrypointAsARegularFile(t *testing.T) {
	archive := tgz(t, archiveEntry{name: "main.js", body: "x"})
	manager := NewTransactionManager(t.TempDir(), memoryFetcher{body: archive})
	transaction, _ := manager.Begin("official", UnitIdentity{Kind: "plugin", ID: "demo", Version: "0.0.1"})
	_, err := manager.Stage(context.Background(), StageRequest{TransactionID: transaction.TransactionID, RegistryID: "official", Unit: UnitIdentity{Kind: "plugin", ID: "demo", Version: "0.0.1"}, Artifact: Artifact{URL: "https://example.invalid/a.tgz", SHA256: sha256Hex(archive), Format: "tgz", Entrypoints: []string{"plugin.json"}}})
	if err == nil || !strings.Contains(err.Error(), "entrypoint") {
		t.Fatalf("error = %v", err)
	}
}
