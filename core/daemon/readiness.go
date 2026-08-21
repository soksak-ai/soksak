package daemon

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/soksak-ai/soksak-core/core/control"
)

// The readiness rule.
//
// A daemon that speaks the control envelope names its own socket on the first
// line it writes to stdout, and that line is the only readiness signal this
// build accepts.
//
// Why not the socket file. A path exists from the moment the daemon binds, and
// it also exists for as long as the filesystem holds one that a dead daemon
// left behind — core/control's Listen removes exactly such a file before
// binding, which is the case where the path was there and nobody was
// answering. So a stat answers "a file is there", never "someone is
// listening", and the only way to turn the first answer into the second is to
// look again: a poll.
//
// Why the first line. It costs the daemon nothing it does not already do, and
// it arrives on a blocking read, so waiting for it is an event boundary rather
// than a loop with a sleep in it. A daemon that prints anything else first has
// spent its announcement, and this build then reports that it announces nothing rather
// than waiting for a line that will never be about a socket.
//
// Why an envelope version travels with it. core/control refuses a version
// mismatch during the greeting rather than at the first command that behaves
// differently, because a mismatch found halfway through a session has already
// produced answers the caller trusted. The announcement is the earliest moment
// that check can happen at all.

// State is what this build has recorded about one daemon's control socket.
type State string

const (
	// Silent is a daemon that has printed nothing yet. Nothing is known about
	// it, and a daemon that never prints stays here — which is not the same
	// answer as one that announced nothing.
	Silent State = "silent"
	// Ready is a daemon that named its socket. The socket is what it said, not
	// what this process found.
	Ready State = "ready"
	// Mute is a daemon whose first line was ordinary output. It announces no
	// socket, and no later line changes that: the first line is spent.
	Mute State = "mute"
	// Refused is a daemon that tried to announce and this build will not use
	// what it said. It is up and unusable, which a caller must not read as
	// still starting.
	Refused State = "refused"
)

// Readiness is one daemon's announcement, as this build read it.
type Readiness struct {
	State State `json:"state"`
	// Socket is filled only in Ready. A refused announcement has none, so
	// nothing can connect to an address this build already rejected.
	Socket string `json:"socket,omitempty"`
	// Reason is filled only in Refused, and states what was wrong with the line.
	Reason string `json:"reason,omitempty"`
}

// announcement is the first line a daemon that speaks the control envelope
// prints.
//
// Both fields are pointers so "absent" and "sent as a zero value" stay apart. A
// daemon that printed an unrelated JSON log line announces nothing; one that
// sent protocol 0 tried to announce and got it wrong. Collapsing those two
// would turn every JSON-logging dev server into a broken sidecar.
type announcement struct {
	Protocol *int    `json:"protocol"`
	Socket   *string `json:"socket"`
}

// readAnnouncement determines what a daemon's first line of stdout stated about
// itself. It performs no I/O: the line is the whole evidence.
func readAnnouncement(line string) Readiness {
	trimmed := strings.TrimSpace(line)
	if !strings.HasPrefix(trimmed, "{") {
		return Readiness{State: Mute}
	}

	var said announcement
	if err := json.Unmarshal([]byte(trimmed), &said); err != nil {
		// A line that opened like an object and is not one is output, not a
		// malformed announcement: a program may print anything.
		return Readiness{State: Mute}
	}
	if said.Protocol == nil && said.Socket == nil {
		return Readiness{State: Mute}
	}
	if said.Protocol == nil {
		return refuse("the announcement named a socket and no protocol, so this build cannot tell which control envelope the daemon speaks")
	}
	if said.Socket == nil {
		return refuse("the announcement named a protocol and no socket, so there is no address to reach the daemon at")
	}
	if *said.Protocol != control.Protocol {
		return refuse(fmt.Sprintf(
			"the daemon announced control protocol %d and this build speaks %d",
			*said.Protocol, control.Protocol))
	}
	if strings.TrimSpace(*said.Socket) == "" {
		return refuse("the announced socket is empty")
	}
	if !filepath.IsAbs(*said.Socket) {
		// A relative path is resolved against a working directory, and the one
		// the daemon used is its own. This process would resolve the same text
		// somewhere else and connect to nothing, or to something else.
		return refuse(fmt.Sprintf(
			"the announced socket %q is relative, and it would resolve against a working directory this process does not share with the daemon",
			*said.Socket))
	}
	return Readiness{State: Ready, Socket: *said.Socket}
}

func refuse(reason string) Readiness {
	return Readiness{State: Refused, Reason: reason}
}
