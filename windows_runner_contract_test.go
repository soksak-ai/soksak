package main

import (
	"os"
	"strings"
	"testing"
)

func TestWindowsBuildRunnerIsSharedByDockerAndActions(t *testing.T) {
	workflow := readText(t, ".github/workflows/windows-terminal-system.yml")
	docker := readText(t, "scripts/ci/windows-docker.sh")
	for path, source := range map[string]string{"workflow": workflow, "docker": docker} {
		if !strings.Contains(source, "windows-build.sh all") {
			t.Errorf("%s does not use windows-build.sh all", path)
		}
	}
	dockerfile := readText(t, "build/docker/Dockerfile.windows-ci")
	for _, required := range []string{"NODE_VERSION=24.19.0", "PNPM_VERSION=10.30.3", "wails3@v3.0.0-beta.12"} {
		if !strings.Contains(dockerfile, required) {
			t.Errorf("Windows CI image does not pin %s", required)
		}
	}
	if !strings.Contains(docker, "io.soksak.windows-ci.definition-sha") {
		t.Fatal("Docker runner rebuilds the CI image without a definition hash")
	}
	runner := readText(t, "scripts/ci/windows-build.sh")
	if !strings.Contains(runner, "Wails binding generation emitted warnings") {
		t.Fatal("Windows binding generation does not reject warnings")
	}
	for _, required := range []string{"generated_source_digest()", "before=$(generated_source_digest)", "after=$(generated_source_digest)", `[ "$before" = "$after" ]`} {
		if !strings.Contains(runner, required) {
			t.Errorf("Windows generation drift gate is missing %q", required)
		}
	}
	if strings.Contains(runner, "git diff") {
		t.Fatal("Windows generation drift gate depends on Git metadata")
	}
}

func readText(t *testing.T, path string) string {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}
