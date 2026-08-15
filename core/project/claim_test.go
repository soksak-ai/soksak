package project

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"
)

// windows answers only "does that window still exist". Reading that from a host
// handle instead would keep the ghost filter inside the app process, and then
// none of it could be checked without a window.
type windows struct {
	mu    sync.Mutex
	alive []string
	// asked counts the readings, because "how many times" is itself a rule:
	// one list has to come from one moment.
	asked int
}

func (w *windows) Live() []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.asked++
	return append([]string(nil), w.alive...)
}

func (w *windows) readings() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.asked
}

func (w *windows) set(labels ...string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.alive = append([]string(nil), labels...)
}

type step struct {
	op           string
	root         string
	label        string
	labels       []string
	wantOk       bool
	wantOwnedBy  string
	wantReleased bool
}

// claimCases is fixtures/project-claims.json carried over as a table.
//
// An earlier build kept it as a file because two implementations had to agree
// about one rule. Here there is one implementation, and reading the file across
// repositories would make this gate depend on a sibling checkout being present.
// The rules are what travels, not the transport.
var claimCases = []struct {
	why    string
	live   []string
	steps  []step
	owners []Owner
}{
	{
		why:    "the first claim on an empty map succeeds",
		live:   []string{"w-1"},
		steps:  []step{{op: "claim", root: "/p", label: "w-1", wantOk: true}},
		owners: []Owner{{Root: "/p", Window: "w-1"}},
	},
	{
		why:  "a re-claim by the same window is idempotent, so restore and retry are safe",
		live: []string{"w-1"},
		steps: []step{
			{op: "claim", root: "/p", label: "w-1", wantOk: true},
			{op: "claim", root: "/p", label: "w-1", wantOk: true},
		},
		owners: []Owner{{Root: "/p", Window: "w-1"}},
	},
	{
		why:  "a root another window holds refuses by naming the owner, so the caller can focus that window",
		live: []string{"w-1", "w-2"},
		steps: []step{
			{op: "claim", root: "/p", label: "w-1", wantOk: true},
			{op: "claim", root: "/p", label: "w-2", wantOk: false, wantOwnedBy: "w-1"},
		},
		owners: []Owner{{Root: "/p", Window: "w-1"}},
	},
	{
		why:  "only the owning window releases; if any window could, the claim is not a claim",
		live: []string{"w-1", "w-2"},
		steps: []step{
			{op: "claim", root: "/p", label: "w-1", wantOk: true},
			{op: "release", root: "/p", label: "w-2", wantReleased: false},
			{op: "release", root: "/p", label: "w-1", wantReleased: true},
		},
		owners: []Owner{},
	},
	{
		why:  "a dead window's claim is not a claim; only live labels own anything",
		live: []string{"w-1"},
		steps: []step{
			{op: "claim", root: "/p", label: "w-1", wantOk: true},
			{op: "alive", labels: []string{"w-2"}},
			{op: "claim", root: "/p", label: "w-2", wantOk: true},
		},
		owners: []Owner{{Root: "/p", Window: "w-2"}},
	},
	{
		why:    "releasing a root nobody claimed is a no-op, because close paths run more than once",
		live:   []string{"w-1"},
		steps:  []step{{op: "release", root: "/nope", label: "w-1", wantReleased: false}},
		owners: []Owner{},
	},
	{
		why:  "one window can hold several roots, and the list is ordered by root so two readings compare",
		live: []string{"w-1"},
		steps: []step{
			{op: "claim", root: "/b", label: "w-1", wantOk: true},
			{op: "claim", root: "/a", label: "w-1", wantOk: true},
		},
		owners: []Owner{{Root: "/a", Window: "w-1"}, {Root: "/b", Window: "w-1"}},
	},
}

func TestTheClaimRulesHold(t *testing.T) {
	for _, testCase := range claimCases {
		t.Run(testCase.why, func(t *testing.T) {
			live := &windows{}
			live.set(testCase.live...)
			ledger := NewLedger(live)

			for index, s := range testCase.steps {
				switch s.op {
				case "claim":
					reply, _, err := ledger.Claim(s.root, s.label)
					if err != nil {
						t.Fatalf("step %d: %v", index, err)
					}
					if reply.Ok != s.wantOk {
						t.Fatalf("step %d: ok = %v, want %v", index, reply.Ok, s.wantOk)
					}
					if reply.OwnedBy != s.wantOwnedBy {
						t.Fatalf("step %d: ownedBy = %q, want %q", index, reply.OwnedBy, s.wantOwnedBy)
					}
				case "release":
					released, err := ledger.Release(s.root, s.label)
					if err != nil {
						t.Fatalf("step %d: %v", index, err)
					}
					if released != s.wantReleased {
						t.Fatalf("step %d: released = %v, want %v", index, released, s.wantReleased)
					}
				case "alive":
					live.set(s.labels...)
				default:
					t.Fatalf("step %d: unknown op %q", index, s.op)
				}
			}

			if got := ledger.Owners(); !reflect.DeepEqual(got, testCase.owners) {
				t.Errorf("owners = %v, want %v", got, testCase.owners)
			}
		})
	}
}

// Notification follows mutation. Broadcasting an unchanged map makes restore and
// retry re-read every window on every step, and a real change is lost in that
// noise.
func TestOnlyAMutationIsAChange(t *testing.T) {
	live := &windows{}
	live.set("w-1", "w-2")
	ledger := NewLedger(live)

	changes := 0
	note := func(changed bool) {
		if changed {
			changes++
		}
	}

	_, changed, _ := ledger.Claim("/p", "w-1")
	note(changed)
	_, changed, _ = ledger.Claim("/p", "w-1")
	note(changed)
	_, changed, _ = ledger.Claim("/p", "w-2")
	note(changed)

	if changes != 1 {
		t.Errorf("changes = %d, want 1: an idempotent re-claim and a refused claim change nothing", changes)
	}
}

func TestARefusedClaimLeavesTheMapAlone(t *testing.T) {
	live := &windows{}
	live.set("w-1", "w-2")
	ledger := NewLedger(live)

	if _, _, err := ledger.Claim("/p", "w-1"); err != nil {
		t.Fatalf("the first claim: %v", err)
	}
	before := ledger.Owners()

	reply, changed, err := ledger.Claim("/p", "w-2")
	if err != nil {
		t.Fatalf("the refused claim answered with an error: %v", err)
	}
	if reply.Ok || reply.OwnedBy != "w-1" {
		t.Errorf("reply = %+v, want the owner named", reply)
	}
	if changed {
		t.Error("a refused claim reported a mutation")
	}
	if got := ledger.Owners(); !reflect.DeepEqual(got, before) {
		t.Errorf("owners = %v, want %v unchanged", got, before)
	}
}

// The window destroyed hook is the primary path. It frees that window and
// nothing else, and the order is fixed so a caller can compare two readings.
func TestWindowDestructionFreesOnlyThatWindow(t *testing.T) {
	live := &windows{}
	live.set("w-1", "main")
	ledger := NewLedger(live)

	for _, claim := range [][2]string{{"/b", "w-1"}, {"/a", "w-1"}, {"/c", "main"}} {
		if _, _, err := ledger.Claim(claim[0], claim[1]); err != nil {
			t.Fatalf("claiming %v: %v", claim, err)
		}
	}

	freed := ledger.ReleaseWindow("w-1")
	if want := []string{"/a", "/b"}; !reflect.DeepEqual(freed, want) {
		t.Errorf("freed = %v, want %v", freed, want)
	}
	if got, want := ledger.Owners(), []Owner{{Root: "/c", Window: "main"}}; !reflect.DeepEqual(got, want) {
		t.Errorf("owners = %v, want %v", got, want)
	}
	if again := ledger.ReleaseWindow("w-1"); len(again) != 0 {
		t.Errorf("a second destruction freed %v", again)
	}
}

// A window that never delivered Destroyed (SIGKILL, a label-reuse race) leaves a
// ghost. Filtering it on the read side alone leaves the write-side symptom
// standing: that project cannot be opened again until the process restarts.
func TestAGhostClaimDoesNotBlockANewOne(t *testing.T) {
	live := &windows{}
	live.set("w-dead")
	ledger := NewLedger(live)

	if _, _, err := ledger.Claim("/p", "w-dead"); err != nil {
		t.Fatalf("the first claim: %v", err)
	}
	live.set("w-new")

	reply, changed, err := ledger.Claim("/p", "w-new")
	if err != nil {
		t.Fatalf("claiming a root held by a window that is gone: %v", err)
	}
	if !reply.Ok {
		t.Fatalf("a ghost claim refused a live one: %+v", reply)
	}
	if !changed {
		t.Error("taking a root from a ghost is a mutation")
	}
	if got, want := ledger.Owners(), []Owner{{Root: "/p", Window: "w-new"}}; !reflect.DeepEqual(got, want) {
		t.Errorf("owners = %v, want %v", got, want)
	}
}

// Measured in an earlier build: a closed project showed as open and selectable.
func TestOwnersListsOnlyLiveWindows(t *testing.T) {
	live := &windows{}
	live.set("w-live", "w-dead")
	ledger := NewLedger(live)

	if _, _, err := ledger.Claim("/live", "w-live"); err != nil {
		t.Fatalf("claiming: %v", err)
	}
	if _, _, err := ledger.Claim("/ghost", "w-dead"); err != nil {
		t.Fatalf("claiming: %v", err)
	}
	live.set("w-live")

	want := []Owner{{Root: "/live", Window: "w-live"}}
	if got := ledger.Owners(); !reflect.DeepEqual(got, want) {
		t.Errorf("owners = %v, want %v", got, want)
	}
}

// An owner that cannot be named can never release, so the root would stay
// unclaimable for the life of the process.
func TestAClaimNeedsBothARootAndAWindowLabel(t *testing.T) {
	live := &windows{}
	live.set("w-1")
	ledger := NewLedger(live)

	if _, _, err := ledger.Claim("/p", ""); err == nil {
		t.Error("a claim with no window label was accepted")
	} else if !strings.Contains(err.Error(), "window") {
		t.Errorf("the refusal did not name what is missing: %v", err)
	}
	if _, _, err := ledger.Claim("", "w-1"); err == nil {
		t.Error("a claim with no root was accepted")
	} else if !strings.Contains(err.Error(), "root") {
		t.Errorf("the refusal did not name what is missing: %v", err)
	}
	if _, err := ledger.Release("/p", ""); err == nil {
		t.Error("a release with no window label was accepted")
	}
}

// Two windows opening the same project at once is the case the rule exists for.
func TestOneRootHasOneWinnerUnderConcurrency(t *testing.T) {
	labels := []string{"w-1", "w-2", "w-3", "w-4", "w-5", "w-6", "w-7", "w-8"}
	live := &windows{}
	live.set(labels...)
	ledger := NewLedger(live)

	var start sync.WaitGroup
	var done sync.WaitGroup
	start.Add(1)
	results := make([]ClaimReply, len(labels))
	changes := make([]bool, len(labels))
	for index, label := range labels {
		done.Add(1)
		go func(index int, label string) {
			defer done.Done()
			start.Wait()
			reply, changed, err := ledger.Claim("/p", label)
			if err != nil {
				panic(fmt.Sprintf("claiming: %v", err))
			}
			results[index] = reply
			changes[index] = changed
		}(index, label)
	}
	start.Done()
	done.Wait()

	winners := 0
	for index := range labels {
		if results[index].Ok {
			winners++
		}
		if changes[index] != results[index].Ok {
			t.Errorf("%s: changed = %v with ok = %v", labels[index], changes[index], results[index].Ok)
		}
	}
	if winners != 1 {
		t.Errorf("winners = %d, want exactly 1", winners)
	}
	if got := ledger.Owners(); len(got) != 1 {
		t.Errorf("owners = %v, want one", got)
	}
}

// The ledger is per-process state and constructing one without a way to ask
// whether a window still exists is a wiring mistake, not a runtime condition.
func TestALedgerWithoutAWindowOracleRefusesToExist(t *testing.T) {
	defer func() {
		if recovered := recover(); recovered == nil {
			t.Error("a ledger with no window oracle was built; its ghosts would block projects until restart")
		}
	}()
	NewLedger(nil)
}

// The destroy hook runs after the host has already dropped the label, so by the
// time it arrives the window is not live. Filtering on liveness here would free
// nothing at the one moment there is something to free: the entries would stay
// in the map, no one would be told the roots came free, and the read-side
// filter would hide a claim that can never be released.
func TestADestroyedWindowIsFreedEvenAfterItsLabelIsGone(t *testing.T) {
	live := &windows{}
	live.set("w-1", "main")
	ledger := NewLedger(live)

	for _, claim := range [][2]string{{"/a", "w-1"}, {"/b", "w-1"}, {"/c", "main"}} {
		if _, _, err := ledger.Claim(claim[0], claim[1]); err != nil {
			t.Fatalf("claiming %v: %v", claim, err)
		}
	}
	// The host noticed the destruction before it told us about it.
	live.set("main")

	freed := ledger.ReleaseWindow("w-1")
	if want := []string{"/a", "/b"}; !reflect.DeepEqual(freed, want) {
		t.Fatalf("freed = %v, want %v: a window already off the live list freed nothing", freed, want)
	}

	// Freed means claimable, not merely hidden. A root still in the map answers
	// Owners with nothing either way, so only a new claim tells the two apart.
	live.set("main", "w-2")
	reply, changed, err := ledger.Claim("/a", "w-2")
	if err != nil {
		t.Fatalf("re-claiming a freed root: %v", err)
	}
	if !reply.Ok || !changed {
		t.Errorf("reply = %+v changed = %v, want a freed root to be claimable", reply, changed)
	}
}

// The wire names are the contract with the frontend, and nothing in the process
// checks them: a publisher spelling the event another way reaches nobody, and
// that silence is not an error — it is a picker that never updates. Measured in
// an earlier build on 2026-08-01, where one framework never published it at all.
// Comparing the constant against itself would pass while it was wrong.
func TestTheWireNamesAreTheOnesTheFrontendReads(t *testing.T) {
	// frontend/src/state/projectRegistry.ts listens for this name.
	if ChangeEvent != "project-registry-change" {
		t.Errorf("ChangeEvent = %q, want project-registry-change", ChangeEvent)
	}

	claimed, err := json.Marshal(ClaimReply{Ok: false, OwnedBy: "w-1"})
	if err != nil {
		t.Fatalf("encoding a claim reply: %v", err)
	}
	// The frontend reads c.ok and c.ownedBy and focuses the named window.
	if got, want := string(claimed), `{"ok":false,"ownedBy":"w-1"}`; got != want {
		t.Errorf("claim reply = %s, want %s", got, want)
	}
	// A successful claim owns nothing else, so the field is absent rather than
	// an empty label the caller would try to focus.
	granted, err := json.Marshal(ClaimReply{Ok: true})
	if err != nil {
		t.Fatalf("encoding a granted claim: %v", err)
	}
	if got, want := string(granted), `{"ok":true}`; got != want {
		t.Errorf("granted claim = %s, want %s", got, want)
	}

	released, err := json.Marshal(ReleaseReply{Released: true})
	if err != nil {
		t.Fatalf("encoding a release reply: %v", err)
	}
	if got, want := string(released), `{"released":true}`; got != want {
		t.Errorf("release reply = %s, want %s", got, want)
	}

	// The picker reads o.root and o.window off each entry.
	owners, err := json.Marshal([]Owner{{Root: "/p", Window: "w-1"}})
	if err != nil {
		t.Fatalf("encoding owners: %v", err)
	}
	if got, want := string(owners), `[{"root":"/p","window":"w-1"}]`; got != want {
		t.Errorf("owners = %s, want %s", got, want)
	}
}

// The frontend calls .filter on this list. A nil slice encodes as null, and
// null has no filter — the rail would throw rather than show an empty list.
func TestAnEmptyLedgerAnswersWithAListNotNull(t *testing.T) {
	live := &windows{}
	live.set("w-1")
	ledger := NewLedger(live)

	owners, err := json.Marshal(ledger.Owners())
	if err != nil {
		t.Fatalf("encoding owners: %v", err)
	}
	if got := string(owners); got != "[]" {
		t.Errorf("owners = %s, want []", got)
	}
	freed, err := json.Marshal(ledger.ReleaseWindow("w-1"))
	if err != nil {
		t.Fatalf("encoding freed roots: %v", err)
	}
	if got := string(freed); got != "[]" {
		t.Errorf("freed = %s, want []", got)
	}
}

// One list must come from one moment. Asking per root lets a window closing
// mid-scan land its earlier roots in the list and its later ones out, and no
// such arrangement was ever true. It also re-enters the host once per claim
// while this ledger's lock is held.
func TestOwnersReadsLivenessOnceForTheWholeList(t *testing.T) {
	live := &windows{}
	live.set("w-1", "w-2")
	ledger := NewLedger(live)

	for _, claim := range [][2]string{{"/a", "w-1"}, {"/b", "w-1"}, {"/c", "w-2"}} {
		if _, _, err := ledger.Claim(claim[0], claim[1]); err != nil {
			t.Fatalf("claiming %v: %v", claim, err)
		}
	}

	before := live.readings()
	if got := ledger.Owners(); len(got) != 3 {
		t.Fatalf("owners = %v, want three", got)
	}
	if asked := live.readings() - before; asked != 1 {
		t.Errorf("liveness was read %d times for a list of three, want once", asked)
	}
}
