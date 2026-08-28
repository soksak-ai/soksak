package repositorygate

import (
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
		`$project.app/Contents/MacOS/$project`,
		`project_identifier=com.$project.core`,
		`CFBundleName`, `CFBundleDisplayName`, `CFBundleExecutable`, `CFBundleIdentifier`,
		`internal/application.defaultProcessLabel=$project`,
		`internal/application.defaultIdentifier=$project_identifier`,
		`main.defaultIdentifier=$project_identifier`,
		`project`, `projectIdentifier`,
	} {
		if !strings.Contains(build, required) {
			t.Errorf("Darwin project builder omits %q", required)
		}
	}
	if strings.Contains(build, "label-or-empty") || strings.Contains(build, "bundle-id-or-empty") {
		t.Error("Darwin builder retains removed label or bundle-id arguments")
	}
	if strings.Contains(build, "build/projects.json") {
		t.Error("Darwin builder requires per-project registration for values derived from PROJECT")
	}
	for _, duplicate := range []string{"bundleIdentifier", "installationIdentifier"} {
		if strings.Contains(build, duplicate) {
			t.Errorf("Darwin builder duplicates project identity as %s", duplicate)
		}
	}
	if !strings.Contains(processLabel, "var defaultProcessLabel = controlwire.DefaultProcessLabel") {
		t.Error("application process label has no build-owned default")
	}
	if !strings.Contains(client, `var defaultIdentifier = "com.soksak.wails"`) {
		t.Error("control-plane client identifier has no build-owned default")
	}

	if _, err := os.Stat("build/projects.json"); !os.IsNotExist(err) {
		t.Fatalf("project registry must not exist: %v", err)
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
