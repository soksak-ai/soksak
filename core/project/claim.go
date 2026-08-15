package project

import (
	"fmt"
	"sort"
	"sync"
)

// ChangeEvent is what a claim mutation is announced as.
//
// A constant rather than a literal at each publisher: spelled out in several
// places, one publisher eventually reaches nobody, and that absence is not an
// error — it is a picker that never updates. Measured
// 2026-08-01: one publisher never sent it at all.
const ChangeEvent = "project-registry-change"

// LiveWindows answers the one fact the ledger needs about windows: whether a
// label still names one.
//
// It is an interface so the rule can be checked with no window at all. The host
// that implements it must answer with the windows that exist — a host that
// answers "none" while windows are open makes every claim look like a ghost.
type LiveWindows interface{ Live() []string }

// ClaimReply crosses the command boundary. A conflict is a value, not an error:
// the command answered, and the answer names the window to focus so the caller
// does not open a second one.
type ClaimReply struct {
	Ok      bool   `json:"ok"`
	OwnedBy string `json:"ownedBy,omitempty"`
}

// ReleaseReply crosses the command boundary.
type ReleaseReply struct {
	Released bool `json:"released"`
}

// Owner is one root and the window holding it.
type Owner struct {
	Root   string `json:"root"`
	Window string `json:"window"`
}

// Ledger enforces the single-open rule: one root is open in at most one window,
// across every window in this process.
//
// It lives in memory and is never persisted. A persisted claim survives a crash
// and makes that project permanently unopenable; a restart is an empty ledger,
// which is the correct state after a crash.
//
// The launcher constructs one and hands it to both this package and the host,
// because the host also has to free a window's roots when the window is
// destroyed. Split per framework, P6 breaks across the halves.
type Ledger struct {
	mu      sync.Mutex
	owners  map[string]string
	windows LiveWindows
}

// NewLedger builds the ledger for this process.
//
// A ledger with no way to ask whether a window still exists is refused here
// rather than later: without it, a window that never delivered its destruction
// leaves a claim that blocks that project until the process restarts.
func NewLedger(windows LiveWindows) *Ledger {
	if windows == nil {
		panic("project: NewLedger needs a way to ask which windows are live")
	}
	return &Ledger{owners: map[string]string{}, windows: windows}
}

// ownerOf answers who holds root, counting only a window that still exists.
//
// The entry itself is left in place. Reaping it here instead would let a host
// whose window list has already dropped a destroyed label find nothing to free,
// and then no one is told the root came free.
func (ledger *Ledger) ownerOf(root string) (string, bool) {
	owner, held := ledger.owners[root]
	if !held {
		return "", false
	}
	for _, label := range ledger.windows.Live() {
		if label == owner {
			return owner, true
		}
	}
	return "", false
}

// Claim takes root for window. The second result says whether the map actually
// changed: notification follows mutation, never the call. Re-announcing an
// unchanged map makes restore and retry re-read every window at every step, and
// the real change is lost in that noise.
//
// A root another live window holds is not an error. The reply names that window
// so the caller focuses it.
func (ledger *Ledger) Claim(root string, window string) (ClaimReply, bool, error) {
	if root == "" {
		return ClaimReply{}, false, fmt.Errorf("project_claim needs a root")
	}
	if window == "" {
		// An owner that cannot be named can never release, so the root would
		// stay unclaimable for the life of the process.
		return ClaimReply{}, false, fmt.Errorf("project_claim needs the calling window label")
	}

	ledger.mu.Lock()
	defer ledger.mu.Unlock()

	if owner, held := ledger.ownerOf(root); held {
		if owner != window {
			return ClaimReply{Ok: false, OwnedBy: owner}, false, nil
		}
		return ClaimReply{Ok: true}, false, nil
	}
	ledger.owners[root] = window
	return ClaimReply{Ok: true}, true, nil
}

// Release drops root, and only for the window that holds it. If any window
// could release any root, a claim is not a claim.
//
// A root nobody holds answers false with no error. Close paths run more than
// once — the close handler, boot, and orchestrator routing all reach here.
func (ledger *Ledger) Release(root string, window string) (bool, error) {
	if root == "" {
		return false, fmt.Errorf("project_release needs a root")
	}
	if window == "" {
		return false, fmt.Errorf("project_release needs the calling window label")
	}

	ledger.mu.Lock()
	defer ledger.mu.Unlock()

	if owner, held := ledger.ownerOf(root); !held || owner != window {
		return false, nil
	}
	delete(ledger.owners, root)
	return true, nil
}

// ReleaseWindow frees every root a destroyed window held, and answers with them
// sorted so two readings compare.
//
// Liveness is not consulted, and that is the point rather than an oversight:
// this is called because the window is gone, so the host's window list has
// usually dropped the label already. Filtering here would find nothing to free
// exactly when there is most to free, the entries would stay in the map, and
// no one would be told the roots came free — the ghost the read-side filter
// exists to hide would become a root nobody can ever claim again.
//
// The caller publishes ChangeEvent when the returned list is not empty. The
// ledger cannot: broadcasting needs a window, and this package holds none. A
// freed root that is announced to nobody leaves the other windows' pickers
// showing a project as open until something unrelated makes them re-read.
func (ledger *Ledger) ReleaseWindow(window string) []string {
	ledger.mu.Lock()
	defer ledger.mu.Unlock()

	freed := make([]string, 0, len(ledger.owners))
	for root, owner := range ledger.owners {
		if owner == window {
			freed = append(freed, root)
		}
	}
	for _, root := range freed {
		delete(ledger.owners, root)
	}
	sort.Strings(freed)
	return freed
}

// Owners lists what is held right now, by root, so two readings compare.
//
// A claim held by a window that no longer exists is not reported. Measured:
// a closed project showed as open and selectable, because a
// window that never delivered its destruction left the claim standing.
//
// Liveness is read once for the whole list, not once per root. Asking per root
// would build one list out of several moments — a window closing mid-scan puts
// its earlier roots in and its later ones out, and that list was never true of
// anything. It also calls into the host once per claim while this lock is held.
func (ledger *Ledger) Owners() []Owner {
	ledger.mu.Lock()
	defer ledger.mu.Unlock()

	live := map[string]bool{}
	for _, label := range ledger.windows.Live() {
		live[label] = true
	}

	owners := make([]Owner, 0, len(ledger.owners))
	for root, owner := range ledger.owners {
		if live[owner] {
			owners = append(owners, Owner{Root: root, Window: owner})
		}
	}
	sort.Slice(owners, func(i, j int) bool { return owners[i].Root < owners[j].Root })
	return owners
}

// OwnersReply carries the holders under a key.
//
// A bare list would be the same JSON as an error that answered nothing, and the
// caller reads `.owners` — measured 2026-08-15, a bare array left that undefined
// and the boot died on it.
type OwnersReply struct {
	Owners []Owner `json:"owners"`
}
