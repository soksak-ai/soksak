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

func TestBrowserFrameSequenceRejectsLateDragWriters(t *testing.T) {
	service := NewService(nil)
	handle := service.install("browser-1", nil)
	newer := Frame{X: 400, Y: 100, Width: 500, Height: 600}
	older := Frame{X: 200, Y: 100, Width: 700, Height: 600}

	if !service.recordFrame(handle, 2, newer) {
		t.Fatal("new frame sequence must be accepted")
	}
	if service.recordFrame(handle, 1, older) {
		t.Fatal("late frame sequence must be rejected")
	}
	status := service.Status()
	if len(status) != 1 || status[0].Sequence != 2 || status[0].Requested != newer {
		t.Fatalf("status must retain the newest frame owner: %+v", status)
	}
}
