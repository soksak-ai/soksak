package wails

import "sync"

// controlPlaneBootstrap closes the launch-time renderer only after both sides of boot are true:
// all saved windows were requested, and at least one workspace renderer declared its command set.
// The close decision is one-shot. A later explicit orchestrator is a user window and is not closed.
type controlPlaneBootstrap struct {
	mu              sync.Mutex
	restoreComplete bool
	workspaceReady  bool
	closeIssued     bool
}

func newControlPlaneBootstrap() *controlPlaneBootstrap { return &controlPlaneBootstrap{} }

func (state *controlPlaneBootstrap) restoreCompleted() bool {
	state.mu.Lock()
	defer state.mu.Unlock()
	state.restoreComplete = true
	return state.closeIfReady()
}

func (state *controlPlaneBootstrap) workspaceDeclared() bool {
	state.mu.Lock()
	defer state.mu.Unlock()
	state.workspaceReady = true
	return state.closeIfReady()
}

func (state *controlPlaneBootstrap) closeIfReady() bool {
	if state.closeIssued || !state.restoreComplete || !state.workspaceReady {
		return false
	}
	state.closeIssued = true
	return true
}

func (state *controlPlaneBootstrap) status() map[string]bool {
	state.mu.Lock()
	defer state.mu.Unlock()
	return map[string]bool{
		"restoreComplete": state.restoreComplete,
		"workspaceReady":  state.workspaceReady,
		"closeIssued":     state.closeIssued,
	}
}
