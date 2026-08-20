package sidecar

import "sync"

// ring keeps the last lines a unit printed to stderr.
//
// Bounded rather than whole: a unit that logs for a week would otherwise cost this process the whole
// week's output for the one moment somebody needs to know why it stopped. What is kept is the tail, which is
// where a failure states itself.
//
// Draining is not optional either. A pipe nobody reads fills, and a unit writing into a full pipe
// blocks — so a host that ignored stderr would stop the unit it started and report nothing about it.
type ring struct {
	mu    sync.Mutex
	lines []string
	limit int
}

func newRing(limit int) *ring {
	if limit <= 0 {
		limit = 64
	}
	return &ring{limit: limit}
}

func (r *ring) add(line string) {
	r.mu.Lock()
	r.lines = append(r.lines, line)
	if len(r.lines) > r.limit {
		r.lines = r.lines[len(r.lines)-r.limit:]
	}
	r.mu.Unlock()
}

func (r *ring) snapshot() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, len(r.lines))
	copy(out, r.lines)
	return out
}
