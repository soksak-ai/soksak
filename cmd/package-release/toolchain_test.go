package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestGoModIsTheOnlyToolchainVersionSource(t *testing.T) {
	root := filepath.Join("..", "..")
	moduleBody, err := os.ReadFile(filepath.Join(root, "go.mod"))
	if err != nil {
		t.Fatal(err)
	}
	match := regexp.MustCompile(`(?m)^go ([0-9]+\.[0-9]+\.[0-9]+)$`).FindSubmatch(moduleBody)
	if len(match) != 2 {
		t.Fatal("go.mod must contain one exact Go version")
	}
	version := string(match[1])
	checks := map[string][]string{
		"build/docker/Dockerfile.cross":                 {"ARG GO_VERSION", "FROM golang:${GO_VERSION}-bookworm AS go-toolchain"},
		"scripts/ci/cross-image.sh":                     {"go_version=$(awk", "--build-arg \"GO_VERSION=$go_version\""},
		"scripts/ci/windows-build.sh":                   {"required=$(awk", "go env GOVERSION"},
		".github/workflows/windows-terminal-system.yml": {"go-version-file: soksak-core/go.mod"},
		".github/workflows/wails-release.yml":           {"go-version-file: source/go.mod"},
	}
	for path, required := range checks {
		body, err := os.ReadFile(filepath.Join(root, path))
		if err != nil {
			t.Fatal(err)
		}
		text := string(body)
		if strings.Contains(text, version) {
			t.Errorf("%s duplicates the canonical Go version", path)
		}
		for _, token := range required {
			if !strings.Contains(text, token) {
				t.Errorf("%s does not derive Go from go.mod through %q", path, token)
			}
		}
	}
}
