package main

import (
	"os"
	"strings"
	"testing"
)

func TestDockerReplaceMountsPreserveTheModuleRelativeAddress(t *testing.T) {
	for _, name := range []string{
		"build/darwin/Taskfile.yml",
		"build/linux/Taskfile.yml",
		"build/windows/Taskfile.yml",
	} {
		body, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		text := string(body)
		if !strings.Contains(text, "container=\"/app/$path\"") ||
			!strings.Contains(text, "echo \"-v $host:$container:ro\"") {
			t.Errorf("%s does not mount a replace target at its /app-relative container address", name)
		}
		if strings.Contains(text, "echo \"-v $path:$path:ro\"") {
			t.Errorf("%s repeats the host address inside the container", name)
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
		"FROM golang:1.25-bookworm AS go-toolchain",
		"FROM ubuntu:24.04",
		"COPY --from=go-toolchain /usr/local/go /usr/local/go",
		"libgtk-4-dev libwebkitgtk-6.0-dev",
	} {
		if !strings.Contains(text, required) {
			t.Errorf("cross image is missing %q", required)
		}
	}
	if strings.Contains(text, "FROM golang:1.25-bookworm\n") {
		t.Error("the Linux build stage still uses Debian Bookworm and GTK 4.8")
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
