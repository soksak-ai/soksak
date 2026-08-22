package main

import (
	"archive/zip"
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPackageWindowsReleaseUsesTheApplicationVersionAndRecordsUnsignedProvenance(t *testing.T) {
	root := t.TempDir()
	frontend := filepath.Join(root, "frontend")
	if err := os.Mkdir(frontend, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(frontend, "package.json"), []byte(`{"name":"@soksak/soksak-core","version":"0.0.1"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	app := filepath.Join(root, "soksak.exe")
	cli := filepath.Join(root, "sok.exe")
	writeMinimalPE(t, app)
	writeMinimalPE(t, cli)
	out := filepath.Join(root, "out")
	commit := strings.Repeat("a", 40)
	if err := packageWindowsRelease(root, out, commit, "32587159592", app, cli); err != nil {
		t.Fatal(err)
	}

	archive := filepath.Join(out, "soksak-0.0.1-windows-x86_64.zip")
	reader, err := zip.OpenReader(archive)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	if len(reader.File) != 2 || reader.File[0].Name != "sok.exe" || reader.File[1].Name != "soksak.exe" {
		t.Fatalf("archive files=%v", zipNames(reader.File))
	}

	body, err := os.ReadFile(filepath.Join(out, "provenance.json"))
	if err != nil {
		t.Fatal(err)
	}
	var provenance releaseProvenance
	if err := json.Unmarshal(body, &provenance); err != nil {
		t.Fatal(err)
	}
	if provenance.Version != "0.0.1" || provenance.Tag != "v0.0.1" || provenance.SourceCommit != commit || provenance.SystemRunID != "32587159592" || provenance.Authenticode != "unsigned" {
		t.Fatalf("provenance=%+v", provenance)
	}
	for _, path := range []string{"SHA256SUMS", "RELEASE-NOTES.md", "RELEASE-NOTES.ko.md"} {
		if info, err := os.Stat(filepath.Join(out, path)); err != nil || info.Size() == 0 {
			t.Fatalf("%s: %v", path, err)
		}
	}
}

func zipNames(files []*zip.File) []string {
	names := make([]string, len(files))
	for index, file := range files {
		names[index] = file.Name
	}
	return names
}

func writeMinimalPE(t *testing.T, path string) {
	t.Helper()
	body := make([]byte, 0x80+4+20)
	body[0], body[1] = 'M', 'Z'
	binary.LittleEndian.PutUint32(body[0x3c:0x40], 0x80)
	copy(body[0x80:0x84], "PE\x00\x00")
	binary.LittleEndian.PutUint16(body[0x84:0x86], 0x8664)
	if err := os.WriteFile(path, body, 0o755); err != nil {
		t.Fatal(err)
	}
}
