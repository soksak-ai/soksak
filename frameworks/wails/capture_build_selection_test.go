package wails

import (
	"encoding/json"
	"os"
	"os/exec"
	"slices"
	"testing"
)

func TestWindowsBuildSelectsTheCaptureBackend(t *testing.T) {
	command := exec.Command("go", "list", "-json", ".")
	command.Env = append(os.Environ(), "GOOS=windows", "GOARCH=amd64", "CGO_ENABLED=0")
	output, err := command.Output()
	if err != nil {
		t.Fatal(err)
	}
	var pkg struct{ GoFiles []string }
	if err := json.Unmarshal(output, &pkg); err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{"capture_windows.go", "capture_native.go", "capture_pixels.go"} {
		if !slices.Contains(pkg.GoFiles, required) {
			t.Errorf("Windows build omits %s: %v", required, pkg.GoFiles)
		}
	}
	if slices.Contains(pkg.GoFiles, "capture_unsupported.go") {
		t.Fatal("Windows build still selects the unsupported capture backend")
	}
}
