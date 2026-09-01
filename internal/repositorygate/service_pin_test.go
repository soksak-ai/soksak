package repositorygate

import (
	"encoding/json"
	"os"
	"regexp"
	"testing"
)

func TestNativeSurfaceConsumersUseTheDeclaredCommits(t *testing.T) {
	selectionBytes, err := os.ReadFile("build/service-pins.json")
	if err != nil {
		t.Fatal(err)
	}
	var selection struct {
		NativeCompositor struct {
			Repository string `json:"repository"`
			Commit     string `json:"commit"`
		} `json:"nativeCompositor"`
		TerminalSurface struct {
			Repository string `json:"repository"`
			Commit     string `json:"commit"`
		} `json:"terminalSurface"`
	}
	if err := json.Unmarshal(selectionBytes, &selection); err != nil {
		t.Fatal(err)
	}
	commit := selection.NativeCompositor.Commit
	if selection.NativeCompositor.Repository != "https://github.com/soksak-ai/soksak-service-native-compositor" ||
		!regexp.MustCompile(`^[a-f0-9]{40}$`).MatchString(commit) {
		t.Fatal("native compositor selection is not an exact repository commit")
	}

	goMod, err := os.ReadFile("go.mod")
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`(?m)^\s*github[.]com/soksak-ai/soksak-service-native-compositor\s+v0\.0\.1$`).Match(goMod) {
		t.Fatal("Go compositor dependency does not use release v0.0.1")
	}
	terminalCommit := selection.TerminalSurface.Commit
	if selection.TerminalSurface.Repository != "https://github.com/soksak-ai/soksak-service-terminal-surface" ||
		!regexp.MustCompile(`^[a-f0-9]{40}$`).MatchString(terminalCommit) {
		t.Fatal("terminal surface selection is not an exact repository commit")
	}
	if !regexp.MustCompile(`(?m)^\s*github[.]com/soksak-ai/soksak-service-terminal-surface\s+v0\.0\.2$`).Match(goMod) {
		t.Fatal("Go terminal surface dependency does not use release v0.0.2")
	}

	packageBytes, err := os.ReadFile("frontend/package.json")
	if err != nil {
		t.Fatal(err)
	}
	var packageManifest struct {
		Dependencies map[string]string `json:"dependencies"`
	}
	if err := json.Unmarshal(packageBytes, &packageManifest); err != nil {
		t.Fatal(err)
	}
	dependency := packageManifest.Dependencies["@soksak/soksak-service-native-compositor"]
	if dependency != "0.0.3" {
		t.Fatalf("frontend compositor dependency does not use release 0.0.3: %s", dependency)
	}
}
