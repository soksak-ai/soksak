package repositorygate

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestDarwinBuildSelectsOneDeclaredProject(t *testing.T) {
	makefile := readBuildContractFile(t, "Makefile")
	build := readBuildContractFile(t, "scripts/ci/darwin-release.sh")
	processLabel := readBuildContractFile(t, "internal/application/process_label.go")
	client := readBuildContractFile(t, "cmd/sok/main.go")

	for _, required := range []string{
		`case "$(origin PROJECT)"`,
		`PROJECT must be a command-line project name`,
		`scripts/ci/darwin-release.sh arm64 '$(PROJECT)'`,
		`scripts/ci/darwin-release.sh x86_64 '$(PROJECT)'`,
	} {
		if !strings.Contains(makefile, required) {
			t.Errorf("Makefile omits project build rule %q", required)
		}
	}
	for _, forbidden := range []string{"origin LABEL", "origin BUNDLE_ID", "$(LABEL)", "$(BUNDLE_ID)"} {
		if strings.Contains(makefile, forbidden) {
			t.Errorf("Makefile retains removed build input %q", forbidden)
		}
	}
	for _, required := range []string{
		`build/projects.json`,
		`$project.app/Contents/MacOS/$project`,
		`CFBundleName`, `CFBundleDisplayName`, `CFBundleExecutable`, `CFBundleIdentifier`,
		`internal/application.defaultProcessLabel=$project`,
		`internal/application.defaultIdentifier=$installation_identifier`,
		`main.defaultIdentifier=$installation_identifier`,
		`project`, `bundleIdentifier`, `installationIdentifier`,
	} {
		if !strings.Contains(build, required) {
			t.Errorf("Darwin project builder omits %q", required)
		}
	}
	if strings.Contains(build, "label-or-empty") || strings.Contains(build, "bundle-id-or-empty") {
		t.Error("Darwin builder retains removed label or bundle-id arguments")
	}
	if !strings.Contains(processLabel, "var defaultProcessLabel = controlwire.DefaultProcessLabel") {
		t.Error("application process label has no build-owned default")
	}
	if !strings.Contains(client, `var defaultIdentifier = "com.soksak.wails"`) {
		t.Error("control-plane client identifier has no build-owned default")
	}

	var projects map[string]struct {
		BundleIdentifier       string `json:"bundleIdentifier"`
		InstallationIdentifier string `json:"installationIdentifier"`
	}
	if err := json.Unmarshal([]byte(readBuildContractFile(t, "build/projects.json")), &projects); err != nil {
		t.Fatal(err)
	}
	want := projects["soksakv3"]
	if want.BundleIdentifier != "com.company.soksakv3" || want.InstallationIdentifier != "com.company.soksakv3" {
		t.Fatalf("soksakv3 project = %+v", want)
	}
}

func readBuildContractFile(t *testing.T, path string) string {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}
