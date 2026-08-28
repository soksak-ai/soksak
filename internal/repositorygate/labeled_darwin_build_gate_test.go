package repositorygate

import (
	"os"
	"strings"
	"testing"
)

func TestDarwinBuildOwnsOneLabeledUserApplication(t *testing.T) {
	makefile := readBuildContractFile(t, "Makefile")
	build := readBuildContractFile(t, "scripts/ci/darwin-release.sh")
	processLabel := readBuildContractFile(t, "internal/application/process_label.go")

	for _, required := range []string{
		`case "$(origin LABEL)"`,
		`LABEL must be a command-line process label`,
		`scripts/ci/darwin-release.sh arm64 '$(LABEL)'`,
		`scripts/ci/darwin-release.sh x86_64 '$(LABEL)'`,
	} {
		if !strings.Contains(makefile, required) {
			t.Errorf("Makefile omits labeled Darwin build rule %q", required)
		}
	}
	for _, required := range []string{
		`$label.app/Contents/MacOS/$label`,
		`CFBundleName`, `CFBundleDisplayName`, `CFBundleExecutable`, `CFBundleIdentifier`,
		`internal/application.defaultProcessLabel=$label`,
		`productLabel`, `bundleIdentifier`,
	} {
		if !strings.Contains(build, required) {
			t.Errorf("Darwin release builder omits %q", required)
		}
	}
	if !strings.Contains(processLabel, "var defaultProcessLabel = controlwire.DefaultProcessLabel") {
		t.Error("application process label has no build-owned default")
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
