package main

import (
	"archive/zip"
	"crypto/sha256"
	"debug/pe"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/soksak-ai/soksak-core/core/i18n"
)

type packageIdentity struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

type releaseAsset struct {
	Name   string `json:"name"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

type releaseProvenance struct {
	Schema       string         `json:"schema"`
	Application  string         `json:"application"`
	Version      string         `json:"version"`
	Tag          string         `json:"tag"`
	SourceCommit string         `json:"sourceCommit"`
	SystemRunID  string         `json:"systemRunId"`
	Platform     string         `json:"platform"`
	Architecture string         `json:"architecture"`
	Authenticode string         `json:"authenticode"`
	Archive      releaseAsset   `json:"archive"`
	ArchiveFiles []releaseAsset `json:"archiveFiles"`
}

var (
	commitPattern  = regexp.MustCompile(`^[0-9a-f]{40}$`)
	versionPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)
)

//go:embed RELEASE-NOTES.md
var releaseNotes string

//go:embed RELEASE-NOTES.ko.md
var releaseNotesKO string

func main() {
	root := flag.String("root", ".", "application source root")
	out := flag.String("out", "dist-release", "release output directory")
	commit := flag.String("source-commit", "", "verified source commit")
	runID := flag.String("system-run-id", "", "successful Windows system run id")
	app := flag.String("app", "bin/soksak.exe", "Windows application binary")
	cli := flag.String("cli", "bin/sok.exe", "Windows control client")
	flag.Parse()
	if err := packageWindowsRelease(*root, *out, *commit, *runID, *app, *cli); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func packageWindowsRelease(root, out, sourceCommit, systemRunID, appPath, cliPath string) error {
	if !commitPattern.MatchString(sourceCommit) {
		return i18n.Errorf("release.sourceCommit", nil)
	}
	if systemRunID == "" || strings.IndexFunc(systemRunID, func(value rune) bool { return value < '0' || value > '9' }) >= 0 {
		return i18n.Errorf("release.systemRunID", nil)
	}
	identity, err := readIdentity(filepath.Join(root, "frontend", "package.json"))
	if err != nil {
		return err
	}
	if identity.Name != "@soksak/soksak-core" || !versionPattern.MatchString(identity.Version) {
		return i18n.Errorf("release.identity", map[string]string{"identity": identity.Name + "@" + identity.Version})
	}
	inputs := []struct{ name, path string }{{"sok.exe", cliPath}, {"soksak.exe", appPath}}
	assets := make([]releaseAsset, 0, len(inputs))
	for _, input := range inputs {
		asset, err := inspectPE(input.name, input.path)
		if err != nil {
			return err
		}
		assets = append(assets, asset)
	}
	sort.Slice(assets, func(i, j int) bool { return assets[i].Name < assets[j].Name })
	if err := os.MkdirAll(out, 0o755); err != nil {
		return err
	}
	archiveName := fmt.Sprintf("soksak-%s-windows-x86_64.zip", identity.Version)
	archivePath := filepath.Join(out, archiveName)
	if err := writeDeterministicZip(archivePath, inputs); err != nil {
		return err
	}
	archive, err := inspectFile(archiveName, archivePath)
	if err != nil {
		return err
	}
	provenance := releaseProvenance{
		Schema: "soksak-application-release-v1", Application: "soksak-core",
		Version: identity.Version, Tag: "v" + identity.Version, SourceCommit: sourceCommit,
		SystemRunID: systemRunID, Platform: "windows", Architecture: "x86_64",
		Authenticode: "unsigned", Archive: archive, ArchiveFiles: assets,
	}
	encoded, err := json.MarshalIndent(provenance, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(out, "provenance.json"), append(encoded, '\n'), 0o644); err != nil {
		return err
	}
	notes := fmt.Sprintf(releaseNotes, identity.Version, systemRunID, sourceCommit)
	notesKO := fmt.Sprintf(releaseNotesKO, identity.Version, systemRunID, sourceCommit)
	if err := os.WriteFile(filepath.Join(out, "RELEASE-NOTES.md"), []byte(notes), 0o644); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(out, "RELEASE-NOTES.ko.md"), []byte(notesKO), 0o644); err != nil {
		return err
	}
	checksummed := []string{archiveName, "provenance.json", "RELEASE-NOTES.md", "RELEASE-NOTES.ko.md"}
	lines := make([]string, 0, len(checksummed))
	for _, name := range checksummed {
		asset, err := inspectFile(name, filepath.Join(out, name))
		if err != nil {
			return err
		}
		lines = append(lines, asset.SHA256+"  "+name)
	}
	return os.WriteFile(filepath.Join(out, "SHA256SUMS"), []byte(strings.Join(lines, "\n")+"\n"), 0o644)
}

func readIdentity(path string) (packageIdentity, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return packageIdentity{}, err
	}
	var identity packageIdentity
	if err := json.Unmarshal(body, &identity); err != nil {
		return packageIdentity{}, err
	}
	return identity, nil
}

func inspectPE(name, path string) (releaseAsset, error) {
	executable, err := pe.Open(path)
	if err != nil {
		return releaseAsset{}, i18n.Errorf("release.notPE", map[string]string{"path": path, "reason": err.Error()})
	}
	defer executable.Close()
	if executable.Machine != pe.IMAGE_FILE_MACHINE_AMD64 {
		return releaseAsset{}, i18n.Errorf("release.notAMD64", map[string]string{"path": path})
	}
	return inspectFile(name, path)
}

func inspectFile(name, path string) (releaseAsset, error) {
	file, err := os.Open(path)
	if err != nil {
		return releaseAsset{}, err
	}
	defer file.Close()
	digest := sha256.New()
	size, err := io.Copy(digest, file)
	if err != nil {
		return releaseAsset{}, err
	}
	if size == 0 {
		return releaseAsset{}, i18n.Errorf("release.empty", map[string]string{"path": path})
	}
	return releaseAsset{Name: name, SHA256: hex.EncodeToString(digest.Sum(nil)), Size: size}, nil
}

func writeDeterministicZip(path string, inputs []struct{ name, path string }) error {
	file, err := os.Create(path)
	if err != nil {
		return err
	}
	writer := zip.NewWriter(file)
	ordered := append([]struct{ name, path string }(nil), inputs...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].name < ordered[j].name })
	for _, input := range ordered {
		header := &zip.FileHeader{Name: input.name, Method: zip.Store}
		header.SetModTime(time.Date(1980, 1, 1, 0, 0, 0, 0, time.UTC))
		header.SetMode(0o755)
		destination, err := writer.CreateHeader(header)
		if err != nil {
			writer.Close()
			file.Close()
			return err
		}
		source, err := os.Open(input.path)
		if err != nil {
			writer.Close()
			file.Close()
			return err
		}
		_, copyErr := io.Copy(destination, source)
		source.Close()
		if copyErr != nil {
			writer.Close()
			file.Close()
			return copyErr
		}
	}
	if err := writer.Close(); err != nil {
		file.Close()
		return err
	}
	return file.Close()
}
