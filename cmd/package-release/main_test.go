package main

import (
	"archive/zip"
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPackageReleaseRequiresAndInspectsEveryDeclaredTarget(t *testing.T) {
	root := releaseFixtureRoot(t)
	inputs := releaseInputs{Targets: []releaseInput{
		fixtureReleaseInput(t, "windows", "x86_64", "401"),
		fixtureReleaseInput(t, "darwin", "arm64", "402"),
		fixtureReleaseInput(t, "darwin", "x86_64", "403"),
		fixtureReleaseInput(t, "darwin", "universal", "404"),
		fixtureReleaseInput(t, "linux", "x86_64", "405"),
		fixtureReleaseInput(t, "linux", "arm64", "406"),
	}}
	out := filepath.Join(root, "out")
	if err := packageRelease(root, out, strings.Repeat("a", 40), inputs); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{
		"soksak-0.0.2-windows-x86_64.zip",
		"soksak-0.0.2-darwin-arm64.tar.gz",
		"soksak-0.0.2-darwin-x86_64.tar.gz",
		"soksak-0.0.2-darwin-universal.tar.gz",
		"soksak-0.0.2-linux-x86_64.tar.gz",
		"soksak-0.0.2-linux-arm64.tar.gz",
		"provenance.json", "SHA256SUMS", "RELEASE-NOTES.md", "RELEASE-NOTES.ko.md",
	} {
		if info, err := os.Stat(filepath.Join(out, name)); err != nil || info.Size() == 0 {
			t.Fatalf("%s: %v", name, err)
		}
	}
	body, err := os.ReadFile(filepath.Join(out, "provenance.json"))
	if err != nil {
		t.Fatal(err)
	}
	var provenance releaseProvenance
	if err := json.Unmarshal(body, &provenance); err != nil {
		t.Fatal(err)
	}
	if provenance.Version != "0.0.2" || len(provenance.Targets) != 6 {
		t.Fatalf("provenance=%+v", provenance)
	}
	for _, target := range provenance.Targets {
		if target.SystemRunID == "" || target.Signing != "unsigned" {
			t.Fatalf("target provenance=%+v", target)
		}
	}
}

func TestPackageReleaseRejectsAnIncompleteMatrix(t *testing.T) {
	root := releaseFixtureRoot(t)
	inputs := releaseInputs{Targets: []releaseInput{fixtureReleaseInput(t, "windows", "x86_64", "401")}}
	if err := packageRelease(root, filepath.Join(root, "out"), strings.Repeat("a", 40), inputs); err == nil {
		t.Fatal("incomplete release matrix was accepted")
	}
}

func TestPackageReleaseRejectsTheWrongExecutableFormat(t *testing.T) {
	root := releaseFixtureRoot(t)
	input := fixtureReleaseInput(t, "linux", "x86_64", "403")
	writeMinimalPE(t, input.Application)
	inputs := completeReleaseInputs(t)
	for index := range inputs.Targets {
		if inputs.Targets[index].Platform == "linux" && inputs.Targets[index].Architecture == "x86_64" {
			inputs.Targets[index] = input
		}
	}
	if err := packageRelease(root, filepath.Join(root, "out"), strings.Repeat("a", 40), inputs); err == nil {
		t.Fatal("Windows PE was accepted as a Linux executable")
	}
}

func zipNames(files []*zip.File) []string {
	names := make([]string, len(files))
	for index, file := range files {
		names[index] = file.Name
	}
	return names
}

func writeMinimalPE(t *testing.T, path string) {
	t.Helper()
	body := make([]byte, 0x80+4+20)
	body[0], body[1] = 'M', 'Z'
	binary.LittleEndian.PutUint32(body[0x3c:0x40], 0x80)
	copy(body[0x80:0x84], "PE\x00\x00")
	binary.LittleEndian.PutUint16(body[0x84:0x86], 0x8664)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, body, 0o755); err != nil {
		t.Fatal(err)
	}
}

func releaseFixtureRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	writeFixture(t, filepath.Join(root, "VERSION"), []byte("0.0.2\n"))
	writeFixture(t, filepath.Join(root, "release", "targets.json"), []byte(`{"targets":[{"platform":"windows","architecture":"x86_64","archiveFormat":"zip"},{"platform":"darwin","architecture":"arm64","archiveFormat":"tar.gz"},{"platform":"darwin","architecture":"x86_64","archiveFormat":"tar.gz"},{"platform":"darwin","architecture":"universal","archiveFormat":"tar.gz"},{"platform":"linux","architecture":"x86_64","archiveFormat":"tar.gz"},{"platform":"linux","architecture":"arm64","archiveFormat":"tar.gz"}]}`))
	return root
}

func completeReleaseInputs(t *testing.T) releaseInputs {
	t.Helper()
	return releaseInputs{Targets: []releaseInput{
		fixtureReleaseInput(t, "windows", "x86_64", "401"),
		fixtureReleaseInput(t, "darwin", "arm64", "402"),
		fixtureReleaseInput(t, "darwin", "x86_64", "403"),
		fixtureReleaseInput(t, "darwin", "universal", "404"),
		fixtureReleaseInput(t, "linux", "x86_64", "405"),
		fixtureReleaseInput(t, "linux", "arm64", "406"),
	}}
}

func fixtureReleaseInput(t *testing.T, platform, architecture, runID string) releaseInput {
	t.Helper()
	directory := filepath.Join(t.TempDir(), platform+"-"+architecture)
	application := filepath.Join(directory, "soksak")
	client := filepath.Join(directory, "sok")
	if platform == "windows" {
		application += ".exe"
		client += ".exe"
		writeMinimalPE(t, application)
		writeMinimalPE(t, client)
	} else if platform == "darwin" {
		application = filepath.Join(directory, "soksak.app")
		if architecture == "universal" {
			writeMinimalFatMachO(t, filepath.Join(application, "Contents", "MacOS", "soksak"))
			writeMinimalFatMachO(t, client)
		} else {
			writeMinimalThinMachO(t, filepath.Join(application, "Contents", "MacOS", "soksak"), architecture)
			writeMinimalThinMachO(t, client, architecture)
		}
		writeFixture(t, filepath.Join(application, "Contents", "Info.plist"), []byte("plist"))
	} else {
		machine := uint16(62)
		if architecture == "arm64" {
			machine = 183
		}
		writeMinimalELF(t, application, machine)
		writeMinimalELF(t, client, machine)
	}
	return releaseInput{Platform: platform, Architecture: architecture, SystemRunID: runID, Application: application, Client: client, Signing: "unsigned"}
}

func writeMinimalThinMachO(t *testing.T, path, architecture string) {
	t.Helper()
	cpu := uint32(0x01000007)
	if architecture == "arm64" {
		cpu = 0x0100000c
	} else if architecture != "x86_64" {
		t.Fatalf("unsupported Mach-O fixture architecture %s", architecture)
	}
	body := make([]byte, 32)
	writeThinMachO(body, cpu, 0)
	writeFixture(t, path, body)
}

func writeMinimalELF(t *testing.T, path string, machine uint16) {
	t.Helper()
	body := make([]byte, 64)
	copy(body, []byte{0x7f, 'E', 'L', 'F', 2, 1, 1})
	binary.LittleEndian.PutUint16(body[16:18], 2)
	binary.LittleEndian.PutUint16(body[18:20], machine)
	binary.LittleEndian.PutUint32(body[20:24], 1)
	binary.LittleEndian.PutUint16(body[52:54], 64)
	binary.LittleEndian.PutUint16(body[54:56], 56)
	binary.LittleEndian.PutUint16(body[58:60], 64)
	writeFixture(t, path, body)
}

func writeMinimalFatMachO(t *testing.T, path string) {
	t.Helper()
	body := make([]byte, 0x140)
	binary.BigEndian.PutUint32(body[0:4], 0xcafebabe)
	binary.BigEndian.PutUint32(body[4:8], 2)
	writeFatArchitecture(body[8:28], 0x01000007, 3, 0x100)
	writeFatArchitecture(body[28:48], 0x0100000c, 0, 0x120)
	writeThinMachO(body[0x100:0x120], 0x01000007, 3)
	writeThinMachO(body[0x120:0x140], 0x0100000c, 0)
	writeFixture(t, path, body)
}

func writeFatArchitecture(body []byte, cpu, subtype, offset uint32) {
	binary.BigEndian.PutUint32(body[0:4], cpu)
	binary.BigEndian.PutUint32(body[4:8], subtype)
	binary.BigEndian.PutUint32(body[8:12], offset)
	binary.BigEndian.PutUint32(body[12:16], 32)
}

func writeThinMachO(body []byte, cpu, subtype uint32) {
	binary.LittleEndian.PutUint32(body[0:4], 0xfeedfacf)
	binary.LittleEndian.PutUint32(body[4:8], cpu)
	binary.LittleEndian.PutUint32(body[8:12], subtype)
	binary.LittleEndian.PutUint32(body[12:16], 2)
}

func writeFixture(t *testing.T, path string, body []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, body, 0o755); err != nil {
		t.Fatal(err)
	}
}
