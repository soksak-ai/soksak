package control

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"net"
	"sync"
)

// maxRequestBytes bounds one line.
//
// Without it a client that never sends a newline makes the reader grow until
// the process dies, and a control plane that can be killed by its own socket is
// not one. A megabyte is far above any real request and far below trouble.
const maxRequestBytes = 1 << 20

// Serve answers requests on a listener until it closes.
//
// The listener arrives built. This package binds nothing itself: a unix socket,
// a named pipe and a test's in-memory pair are the same stream of lines here,
// and choosing between them needs to know the platform — which is the
// launcher's to know, not the core's.
//
// Serve returns when the listener stops accepting. Closing the listener is how
// a caller stops it; there is nothing to poll and no shutdown handshake,
// because a control plane that must be asked politely to stop cannot be stopped
// by the thing that noticed it should.
func Serve(listener net.Listener, registry *Registry, identity string) error {
	var connections sync.WaitGroup
	defer connections.Wait()

	for {
		connection, err := listener.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			return err
		}
		connections.Add(1)
		go func() {
			defer connections.Done()
			defer func() { _ = connection.Close() }()
			answerAll(connection, connection, registry, identity)
		}()
	}
}

// answerAll reads requests and writes answers until the reader ends.
//
// One connection is one conversation, handled in order. Requests are not run
// concurrently within a connection: a caller that sends "create then place"
// means them in that order, and the id exists to match answers, not to license
// reordering.
func answerAll(reader io.Reader, writer io.Writer, registry *Registry, identity string) {
	lines := bufio.NewScanner(reader)
	lines.Buffer(make([]byte, 0, 4096), maxRequestBytes)
	encoder := json.NewEncoder(writer)

	for lines.Scan() {
		line := lines.Bytes()
		if len(line) == 0 {
			continue
		}

		var request Request
		if err := json.Unmarshal(line, &request); err != nil {
			// The id is unknown, so this answer cannot be matched to anything.
			// It is sent anyway: a client that gets silence cannot tell a
			// malformed request from a command that hangs.
			_ = encoder.Encode(Response{Error: "the request was not one line of JSON: " + err.Error()})
			continue
		}
		if err := encoder.Encode(Answer(registry, identity, request)); err != nil {
			return
		}
	}
	if err := lines.Err(); err != nil {
		_ = encoder.Encode(Response{Error: "the request could not be read: " + err.Error()})
	}
}
