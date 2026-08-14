package nativebrowser

import "testing"

func TestBrowserSessionGenerationRejectsStaleWriters(t *testing.T) {
	service := NewService(nil)
	first := service.install("browser-1", nil)
	second := service.install("browser-1", nil)
	if first.Generation == second.Generation {
		t.Fatal("replacement browser must receive a fresh generation")
	}
	if service.remove(first.ID, first.Generation) {
		t.Fatal("stale generation must not remove the replacement browser")
	}
	if !service.remove(second.ID, second.Generation) {
		t.Fatal("current generation must remove its browser")
	}
}

func TestBrowserFrameContract(t *testing.T) {
	valid := Frame{X: 10, Y: 20, Width: 640, Height: 480}
	if err := valid.Validate(); err != nil {
		t.Fatalf("finite non-empty browser frame must be valid: %v", err)
	}
	for _, invalid := range []Frame{
		{X: 0, Y: 0, Width: 0, Height: 480},
		{X: 0, Y: 0, Width: 640, Height: 0},
		{X: 0, Y: 0, Width: -1, Height: 480},
	} {
		if err := invalid.Validate(); err == nil {
			t.Fatalf("invalid browser frame must be rejected: %+v", invalid)
		}
	}
}
