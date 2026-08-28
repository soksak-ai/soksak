//go:build darwin && cgo

package application

import (
	"os"
	"testing"
)

func TestDarwinLaunchPublishesTheAcceptedProcessLabel(t *testing.T) {
	label, err := launchProcessLabel("soksakv3")
	if err != nil {
		t.Fatal(err)
	}
	actual, err := currentDarwinProcessName(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	if actual != label {
		t.Fatalf("Darwin process name = %q, want accepted process label %q", actual, label)
	}
}
