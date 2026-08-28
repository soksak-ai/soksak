package repositorygate

import (
	"encoding/json"
	"os"
	"regexp"
	"strings"
	"testing"
)

func TestNativeCompositorConsumersUseTheDeclaredCommit(t *testing.T) {
	selectionBytes, err := os.ReadFile("build/service-pins.json")
	if err != nil {
		t.Fatal(err)
	}
	var selection struct {
		NativeCompositor struct {
			Repository string `json:"repository"`
			Commit     string `json:"commit"`
		} `json:"nativeCompositor"`
	}
	if err := json.Unmarshal(selectionBytes, &selection); err != nil {
		t.Fatal(err)
	}
	commit := selection.NativeCompositor.Commit
	if selection.NativeCompositor.Repository != "https://github.com/min-median-max/wails-service-native-compositor" ||
		!regexp.MustCompile(`^[a-f0-9]{40}$`).MatchString(commit) {
		t.Fatal("native compositor selection is not an exact repository commit")
	}

	goMod, err := os.ReadFile("go.mod")
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`(?m)^\s*github[.]com/min-median-max/wails-service-native-compositor\s+v\S+-` + commit[:12] + `$`).Match(goMod) {
		t.Fatalf("Go compositor dependency does not use %s", commit)
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
	dependency := packageManifest.Dependencies["@min-median-max/wails-service-native-compositor"]
	if !strings.HasSuffix(dependency, "#"+commit[:12]) {
		t.Fatalf("frontend compositor dependency does not use %s", commit)
	}
}
