//go:build darwin

package wails

import "testing"

func TestDarwinProcessLabelIsAppliedAndReadBack(t *testing.T) {
	original := currentProcessLabel()
	if original == "" {
		t.Fatal("NSProcessInfo returned no process name")
	}
	t.Cleanup(func() {
		if _, err := ApplyProcessLabel(original); err != nil {
			t.Errorf("restoring process label: %v", err)
		}
	})
	got, err := ApplyProcessLabel("soksakv3")
	if err != nil {
		t.Fatal(err)
	}
	if got != "soksakv3" || currentProcessLabel() != "soksakv3" {
		t.Fatalf("process label = %q, current = %q", got, currentProcessLabel())
	}
}
