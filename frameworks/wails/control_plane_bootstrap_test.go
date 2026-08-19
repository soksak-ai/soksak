package wails

import "testing"

func TestBootstrapControlPlaneClosesOnlyAfterRestoreAndWorkspaceReadiness(t *testing.T) {
	for _, order := range [][]string{
		{"restore", "workspace"},
		{"workspace", "restore"},
	} {
		state := newControlPlaneBootstrap()
		closed := 0
		for _, event := range order {
			var closeNow bool
			switch event {
			case "restore":
				closeNow = state.restoreCompleted()
			case "workspace":
				closeNow = state.workspaceDeclared()
			}
			if closeNow {
				closed++
			}
		}
		if closed != 1 {
			t.Fatalf("order %v closed %d times, want once", order, closed)
		}
		if state.restoreCompleted() || state.workspaceDeclared() {
			t.Fatalf("order %v closed more than once", order)
		}
	}
}

func TestBootstrapControlPlaneStaysWhenNoWorkspaceDeclares(t *testing.T) {
	state := newControlPlaneBootstrap()
	if state.restoreCompleted() {
		t.Fatal("restore completion alone closed the control plane")
	}
}
