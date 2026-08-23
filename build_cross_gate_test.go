package main

import (
	"os"
	"strings"
	"testing"
)

func TestBuildsDoNotSupportLocalDependencyTopology(t *testing.T) {
	for _, name := range []string{
		"go.mod",
		"scripts/ci/cross-build.sh",
		"scripts/ci/windows-docker.sh",
		"build/darwin/Taskfile.yml",
		"build/linux/Taskfile.yml",
		"build/windows/Taskfile.yml",
		"build/docker/Dockerfile.server",
	} {
		body, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		text := string(body)
		for _, forbidden := range []string{"replace ", "REPLACE_MOUNTS", "^replace", "../soksak-", "GITHUB_WORKSPACE/soksak-"} {
			if strings.Contains(text, forbidden) {
				t.Errorf("%s supports local dependency topology through %q", name, forbidden)
			}
		}
	}
}

func TestCrossImageMatchesTheDeclaredLinuxBaseline(t *testing.T) {
	body, err := os.ReadFile("build/docker/Dockerfile.cross")
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)
	for _, required := range []string{
		"ARG GO_VERSION=must-be-provided",
		"FROM golang:${GO_VERSION}-bookworm AS go-toolchain",
		"FROM ubuntu:24.04",
		"COPY --from=go-toolchain /usr/local/go /usr/local/go",
		"libgtk-4-dev libwebkitgtk-6.0-dev",
	} {
		if !strings.Contains(text, required) {
			t.Errorf("cross image is missing %q", required)
		}
	}
	for _, forbidden := range []string{"nodejs npm", "libgtk-3-dev", "libwebkit2gtk-4.1-dev"} {
		if strings.Contains(text, forbidden) {
			t.Errorf("cross compiler retains frontend or GTK3 dependency %q", forbidden)
		}
	}
	if strings.Contains(text, "FROM golang:bookworm\n") {
		t.Error("the Linux build stage still uses Debian Bookworm and GTK 4.8")
	}
}

func TestCrossTasksUseAnImageBuiltForTheTargetArchitecture(t *testing.T) {
	for _, path := range []string{"build/darwin/Taskfile.yml", "build/linux/Taskfile.yml"} {
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		text := string(body)
		if !strings.Contains(text, `CROSS_IMAGE: 'wails-cross-{{.DOCKER_ARCH}}'`) {
			t.Errorf("%s does not select the target-architecture cross image", path)
		}
	}
}

func TestLinuxVisualSmokeUsesTheBuiltApplication(t *testing.T) {
	body, err := os.ReadFile("build/linux/smoke.sh")
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)
	for _, required := range []string{
		"xdotool search --sync --onlyvisible --pid",
		"timeout 20 xdotool",
		"import -window \"$window\" \"$output\"",
		"kill -0 \"$pid\"",
		"test \"$colors\" -gt 16",
		"WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1",
		"WEBKIT_DISABLE_COMPOSITING_MODE=1",
		"GSK_RENDERER=cairo",
		"plugin.boot.wait",
		"attempt=$((attempt + 1))",
		"ui.tree window=main",
	} {
		if !strings.Contains(text, required) {
			t.Errorf("Linux visual smoke is missing %q", required)
		}
	}
}
