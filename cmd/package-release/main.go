package main

import (
	_ "embed"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/soksak-ai/soksak-core/core/i18n"
)

type releaseInput struct {
	Platform     string `json:"platform"`
	Architecture string `json:"architecture"`
	SystemRunID  string `json:"systemRunId"`
	Application  string `json:"application"`
	Client       string `json:"client"`
	Signing      string `json:"signing"`
}

type releaseInputs struct {
	Targets []releaseInput `json:"targets"`
}

type releaseTarget struct {
	Platform      string `json:"platform"`
	Architecture  string `json:"architecture"`
	ArchiveFormat string `json:"archiveFormat"`
}

type releaseTargets struct {
	Targets []releaseTarget `json:"targets"`
}

type releaseAsset struct {
	Name   string `json:"name"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

type targetProvenance struct {
	Platform     string         `json:"platform"`
	Architecture string         `json:"architecture"`
	SystemRunID  string         `json:"systemRunId"`
	Signing      string         `json:"signing"`
	Archive      releaseAsset   `json:"archive"`
	ArchiveFiles []releaseAsset `json:"archiveFiles"`
}

type releaseProvenance struct {
	Schema       string             `json:"schema"`
	Application  string             `json:"application"`
	Version      string             `json:"version"`
	Tag          string             `json:"tag"`
	SourceCommit string             `json:"sourceCommit"`
	Targets      []targetProvenance `json:"targets"`
}

type archiveInput struct {
	Name, Path string
}

type matchedInput struct {
	target releaseTarget
	input  releaseInput
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
	inputsPath := flag.String("inputs", "", "verified target input document")
	flag.Parse()
	inputs, err := readJSON[releaseInputs](*inputsPath)
	if err == nil {
		err = packageRelease(*root, *out, *commit, inputs)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func packageRelease(root, out, sourceCommit string, inputs releaseInputs) error {
	if !commitPattern.MatchString(sourceCommit) {
		return i18n.Errorf("release.sourceCommit", nil)
	}
	version, err := readVersion(filepath.Join(root, "VERSION"))
	if err != nil {
		return err
	}
	declared, err := readJSON[releaseTargets](filepath.Join(root, "release", "targets.json"))
	if err != nil {
		return err
	}
	ordered, err := matchInputs(declared.Targets, inputs.Targets)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(out, 0o755); err != nil {
		return err
	}
	provenance := releaseProvenance{
		Schema: "soksak-application-release-v2", Application: "soksak-core",
		Version: version, Tag: "v" + version, SourceCommit: sourceCommit,
	}
	checksummed := make([]string, 0, len(ordered)+3)
	for _, item := range ordered {
		entry, err := packageTarget(out, version, item.target, item.input)
		if err != nil {
			return err
		}
		provenance.Targets = append(provenance.Targets, entry)
		checksummed = append(checksummed, entry.Archive.Name)
	}
	encoded, err := json.MarshalIndent(provenance, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(out, "provenance.json"), append(encoded, '\n'), 0o644); err != nil {
		return err
	}
	runs := make([]string, 0, len(provenance.Targets))
	for _, target := range provenance.Targets {
		runs = append(runs, fmt.Sprintf("%s/%s=%s", target.Platform, target.Architecture, target.SystemRunID))
	}
	if err := os.WriteFile(filepath.Join(out, "RELEASE-NOTES.md"), []byte(fmt.Sprintf(releaseNotes, version, strings.Join(runs, ", "), sourceCommit)), 0o644); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(out, "RELEASE-NOTES.ko.md"), []byte(fmt.Sprintf(releaseNotesKO, version, strings.Join(runs, ", "), sourceCommit)), 0o644); err != nil {
		return err
	}
	checksummed = append(checksummed, "provenance.json", "RELEASE-NOTES.md", "RELEASE-NOTES.ko.md")
	return writeChecksums(out, checksummed)
}

func matchInputs(targets []releaseTarget, inputs []releaseInput) ([]matchedInput, error) {
	if len(targets) == 0 || len(inputs) != len(targets) {
		return nil, i18n.Errorf("release.matrix", nil)
	}
	byKey := make(map[string]releaseInput, len(inputs))
	for _, input := range inputs {
		key := input.Platform + "/" + input.Architecture
		if _, exists := byKey[key]; exists || !decimal(input.SystemRunID) || input.Application == "" || input.Client == "" || input.Signing == "" {
			return nil, i18n.Errorf("release.input", map[string]string{"target": key})
		}
		byKey[key] = input
	}
	matched := make([]matchedInput, 0, len(targets))
	for _, target := range targets {
		key := target.Platform + "/" + target.Architecture
		input, ok := byKey[key]
		if !ok || (target.ArchiveFormat != "zip" && target.ArchiveFormat != "tar.gz") {
			return nil, i18n.Errorf("release.matrix", nil)
		}
		matched = append(matched, matchedInput{target: target, input: input})
		delete(byKey, key)
	}
	if len(byKey) != 0 {
		return nil, i18n.Errorf("release.matrix", nil)
	}
	return matched, nil
}

func readVersion(path string) (string, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	version := strings.TrimSpace(string(body))
	if string(body) != version+"\n" || !versionPattern.MatchString(version) {
		return "", i18n.Errorf("release.version", nil)
	}
	return version, nil
}

func readJSON[T any](path string) (T, error) {
	var value T
	file, err := os.Open(path)
	if err != nil {
		return value, err
	}
	defer file.Close()
	decoder := json.NewDecoder(file)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return value, err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return value, i18n.Errorf("release.trailingJSON", nil)
	}
	return value, nil
}

func decimal(value string) bool {
	return value != "" && strings.IndexFunc(value, func(character rune) bool { return character < '0' || character > '9' }) < 0
}
