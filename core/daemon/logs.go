package daemon

import "sync"

// ringCapacity is how many of a daemon's most recent lines this build keeps.
//
// The log lives in memory and nothing is written to disk, which is the contract
// the catalogue states to the user: a daemon whose output must survive
// redirects it inside its own command line. 500 is what the caller is promised,
// and it bounds what a chatty dev server can cost — a daemon printing a line a
// millisecond would otherwise grow this process until it died, and a workspace
// that dies from watching a build is worse than one that forgets the first
// hour of it.
const ringCapacity = 500

// defaultLines is what daemon_logs answers when the caller names no count.
const defaultLines = 100

// ring is one daemon's recent output, oldest first.
//
// Both output pipes feed one ring in arrival order, because that is the order a
// person reading a log needs: a stderr line explains the stdout line before it,
// and separating the two loses which came first. Lines are kept verbatim — no
// stream tag, no timestamp prefix — because callers parse them (release.build
// finds its summary line by prefix), and a prefix added here would make every
// such line unrecognisable.
type ring struct {
	mu    sync.Mutex
	lines []string
	// start is where the oldest held line sits once the ring has wrapped.
	start int
}

func newRing() *ring {
	return &ring{lines: make([]string, 0, ringCapacity)}
}

func (held *ring) keep(line string) {
	held.mu.Lock()
	defer held.mu.Unlock()

	if len(held.lines) < ringCapacity {
		held.lines = append(held.lines, line)
		return
	}
	held.lines[held.start] = line
	held.start = (held.start + 1) % ringCapacity
}

// recent answers the last count lines in arrival order.
//
// The slice is a copy: the caller encodes it while the daemon keeps printing,
// and handing out the storage would let a line change under the encoder.
func (held *ring) recent(count int) []string {
	held.mu.Lock()
	defer held.mu.Unlock()

	if count > len(held.lines) {
		count = len(held.lines)
	}
	// Never nil. An empty log and a log this build cannot read must not arrive
	// at the caller as the same JSON null.
	out := make([]string, 0, count)
	for index := len(held.lines) - count; index < len(held.lines); index++ {
		out = append(out, held.lines[(held.start+index)%len(held.lines)])
	}
	return out
}
