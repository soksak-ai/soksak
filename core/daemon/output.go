package daemon

import (
	"bufio"
	"fmt"
	"io"
)

// maxLineBytes is the longest single line this build keeps whole.
//
// It matches the control plane's request bound for the same reason: a producer
// that never sends a newline would otherwise make the reader grow until the
// process dies, and a workspace that can be killed by a daemon's output is not
// one. A megabyte is far above any real log line.
const maxLineBytes = 1 << 20

// pump turns one of a child's output pipes into lines.
//
// Draining is not optional and never stops early. A reader that stops reading
// fills the child's pipe, the child blocks in write, and a daemon that is
// blocked in write cannot be stopped by anything short of a kill — core/process
// states the same rule for the same reason. So every exit from the scanner ends
// in a drain rather than a return.
//
// announce is called with the very first line and then never again; it is nil
// for stderr. The first line is where the readiness rule applies, and a line
// that arrives second cannot be the first one no matter what it holds.
func pump(reader io.ReadCloser, announce func(line string), keep func(line string)) {
	defer func() { _ = reader.Close() }()

	lines := bufio.NewScanner(reader)
	lines.Buffer(make([]byte, 0, 4096), maxLineBytes)

	first := true
	for lines.Scan() {
		line := lines.Text()
		if first {
			first = false
			if announce != nil {
				announce(line)
			}
		}
		keep(line)
	}
	if err := lines.Err(); err != nil {
		// Recorded rather than passed over: the log stops here and the reader
		// must be told that it stopped, or a daemon that is still printing
		// reads as one that went quiet.
		keep(fmt.Sprintf("[soksak] this daemon's output stopped being kept: %v", err))
		// The child keeps writing. Draining into nothing is what stops it from
		// blocking on a full pipe.
		_, _ = io.Copy(io.Discard, reader)
	}
}
