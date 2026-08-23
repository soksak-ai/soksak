package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

var applicationVersionPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)

func TestApplicationVersionHasOneCanonicalSourceAndExactProjections(t *testing.T) {
	root := filepath.Join("..", "..")
	body, err := os.ReadFile(filepath.Join(root, "VERSION"))
	if err != nil {
		t.Fatal(err)
	}
	version := strings.TrimSpace(string(body))
	if !applicationVersionPattern.MatchString(version) || string(body) != version+"\n" {
		t.Fatalf("invalid canonical application version %q", body)
	}
	packageBody, err := os.ReadFile(filepath.Join(root, "frontend", "package.json"))
	if err != nil {
		t.Fatal(err)
	}
	var packageIdentity struct {
		Name, Version string
	}
	if err := json.Unmarshal(packageBody, &packageIdentity); err != nil {
		t.Fatal(err)
	}
	if packageIdentity.Name != "@soksak/soksak-core" || packageIdentity.Version != version {
		t.Fatalf("frontend identity=%s@%s, want @soksak/soksak-core@%s", packageIdentity.Name, packageIdentity.Version, version)
	}
	for _, projection := range []struct {
		path, versionText, productText string
	}{
		{"build/config.yml", `version: "` + version + `"`, `productName: "soksak"`},
		{"build/windows/info.json", `"file_version": "` + version + `"`, `"ProductVersion": "` + version + `"`},
		{"build/windows/wails.exe.manifest", `version="` + version + `.0"`, `name="com.soksak.core"`},
		{"build/windows/msix/template.xml", `Version="` + version + `.0"`, `Id="com.soksak.core"`},
		{"build/windows/msix/app_manifest.xml", `Version="` + version + `.0"`, `Name="com.soksak.core"`},
		{"build/windows/nsis/wails_tools.nsh", `INFO_PRODUCTVERSION "` + version + `"`, `INFO_PROJECTNAME "soksak"`},
		{"build/darwin/Info.plist", `<string>` + version + `</string>`, `<string>soksak</string>`},
		{"build/darwin/Info.dev.plist", `<string>` + version + `</string>`, `<string>soksak</string>`},
		{"build/linux/nfpm/nfpm.yaml", `version: "` + version + `"`, `name: "soksak"`},
		{"build/linux/desktop", `Exec=/usr/local/bin/soksak %u`, `StartupWMClass=soksak`},
		{"README.md", "version `" + version + "`", "plugin-driven Wails desktop core"},
		{"README.ko.md", "`" + version + "`", "Wails desktop core"},
	} {
		projected, err := os.ReadFile(filepath.Join(root, projection.path))
		if err != nil {
			t.Fatal(err)
		}
		text := string(projected)
		if !strings.Contains(text, projection.versionText) || !strings.Contains(text, projection.productText) {
			t.Errorf("%s does not project soksak %s", projection.path, version)
		}
	}
}

func TestApplicationReleaseDeclaresEverySupportedTarget(t *testing.T) {
	body, err := os.ReadFile(filepath.Join("..", "..", "release", "targets.json"))
	if err != nil {
		t.Fatal(err)
	}
	var document struct {
		Targets []struct {
			Platform, Architecture, ArchiveFormat string
		}
	}
	if err := json.Unmarshal(body, &document); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"windows/x86_64":   "zip",
		"darwin/universal": "tar.gz",
		"linux/x86_64":     "tar.gz",
		"linux/arm64":      "tar.gz",
	}
	for _, target := range document.Targets {
		key := target.Platform + "/" + target.Architecture
		if format, ok := want[key]; !ok || format != target.ArchiveFormat {
			t.Fatalf("undeclared release target or format: %+v", target)
		}
		delete(want, key)
	}
	if len(want) != 0 {
		t.Fatalf("missing release targets: %v", want)
	}
}
