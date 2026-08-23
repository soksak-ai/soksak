package repositorygate

import (
	"os"
	"strings"
	"testing"
)

func TestLinuxSmokeProvidesSecretService(t *testing.T) {
	dockerfile, err := os.ReadFile("build/linux/Dockerfile.smoke")
	if err != nil {
		t.Fatal(err)
	}
	smoke, err := os.ReadFile("build/linux/smoke.sh")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(dockerfile), "gnome-keyring") {
		t.Fatal("Linux smoke image does not install Secret Service")
	}
	if !strings.Contains(string(smoke), "gnome-keyring-daemon --unlock") {
		t.Fatal("Linux smoke run does not start Secret Service")
	}
	if !strings.Contains(string(dockerfile), "openbox") || !strings.Contains(string(smoke), "openbox") {
		t.Fatal("Linux smoke does not provide a window manager for resize and focus contracts")
	}
}
