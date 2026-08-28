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
		`case "$(origin BUNDLE_ID)"`,
		`LABEL must be a command-line process label`,
		`BUNDLE_ID must be a command-line application identifier`,
		`scripts/ci/darwin-release.sh arm64 '$(LABEL)' '$(BUNDLE_ID)'`,
		`scripts/ci/darwin-release.sh x86_64 '$(LABEL)' '$(BUNDLE_ID)'`,
	} {
		if !strings.Contains(makefile, required) {
			t.Errorf("Makefile omits labeled Darwin build rule %q", required)
		}
	}
	for _, required := range []string{
		`$label.app/Contents/MacOS/$label`,
		`CFBundleName`, `CFBundleDisplayName`, `CFBundleExecutable`, `CFBundleIdentifier`,
		`internal/application.defaultProcessLabel=$label`,
		`internal/application.defaultIdentifier=$bundle_identifier`,
		`productLabel`, `bundleIdentifier`,
	} {
		if !strings.Contains(build, required) {
			t.Errorf("Darwin release builder omits %q", required)
		}
	}
	if !strings.Contains(processLabel, "var defaultProcessLabel = controlwire.DefaultProcessLabel") {
		t.Error("application process label has no build-owned default")
	}
	if strings.Contains(build, "bundle_identifier=com.soksak.core.$label") {
		t.Error("Darwin builder derives stable bundle identity from the presentation label")
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
