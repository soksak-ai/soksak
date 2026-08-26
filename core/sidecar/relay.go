package sidecar

import (
	"bufio"
	"encoding/json"
	"io"
	"strconv"
	"sync"

	controlwire "github.com/soksak-ai/soksak-contract-control"
	"github.com/soksak-ai/soksak-core/core/i18n"
)

// The relay. What crosses it is opaque.
//
// A request goes out as it arrived and an answer comes back as it was given. The meaning is a
// contract between the plugin that declared the unit and the unit itself, and a host that read it
// would need editing for every unit anyone writes — which is the lock-in the substrate exists to
// prevent.
//
// One greeted connection per unit, reused by every send. A connect and a greeting per request is a
// round trip on every keystroke a plugin relays, and it is paid twice by a plugin that writes and
// then reads. Answers are matched to requests by an id this relay puts on the wire, so callers may
// overlap and keep their own ids.
//
// A connection the unit closes is dropped and the next send opens another; a request already on the
// wire when that happened is answered with the failure rather than repeated, because the unit may
// have acted on it. Streams keep a connection of their own: the bytes after their one answer belong
// to them.

// linkEnded is the refusal a request left waiting on a closed connection answers with.
func linkEnded(name string) error {
	return i18n.Errorf("sidecar.connectionEnded", map[string]string{"name": name})
}

// link is one greeted connection held open for a unit.
type link struct {
	name   string
	conn   io.ReadWriteCloser
	reader *bufio.Reader
	// write serializes request lines; answers arrive on one reader goroutine.
	write sync.Mutex

	mu      sync.Mutex
	pending map[string]pendingCall
	next    uint64
	closed  bool
	failure error
}

// pendingCall is one request waiting for its answer. id is the caller's own, restored on the way
// back so a caller never sees the wire id this relay used.
type pendingCall struct {
	id    string
	reply chan controlwire.Response
}

// Send takes one request to a unit and answers with what came back.
//
// A unit that is not open is refused rather than started. Opening is where the declaration is
// checked — that the caller declared this unit, and that the unit implements the contract that was
// declared — and a send that started one would be a way past both checks.
func (host *Host) Send(name string, request controlwire.Request) (controlwire.Response, error) {
	for attempt := 0; ; attempt++ {
		held, err := host.heldLink(name)
		if err != nil {
			return controlwire.Response{}, err
		}
		answer, written, err := held.call(request)
		if err == nil {
			return answer, nil
		}
		host.dropLink(held, err)
		// A request that never left is safe to send again on a fresh connection: the unit did not
		// see it. One that did leave is not, so its failure is the answer.
		if !written && attempt == 0 {
			continue
		}
		return controlwire.Response{}, i18n.Errorf("sidecar.noAnswer", map[string]string{
			"name": name, "reason": err.Error(),
		})
	}
}

// heldLink answers the unit's open connection, greeting a new one when none is held.
func (host *Host) heldLink(name string) (*link, error) {
	host.mu.Lock()
	held := host.links[name]
	host.mu.Unlock()
	if held != nil && !held.isClosed() {
		return held, nil
	}
	conn, reader, _, err := host.connect(name)
	if err != nil {
		return nil, err
	}
	fresh := &link{name: name, conn: conn, reader: reader, pending: map[string]pendingCall{}}
	host.mu.Lock()
	if host.links == nil {
		host.links = map[string]*link{}
	}
	// Another caller may have greeted one while this connection was being made. Theirs stays; this
	// one is closed rather than left open with nobody reading it.
	if existing := host.links[name]; existing != nil && !existing.isClosed() {
		host.mu.Unlock()
		_ = conn.Close()
		return existing, nil
	}
	host.links[name] = fresh
	host.mu.Unlock()
	go host.readAnswers(fresh)
	return fresh, nil
}

// readAnswers delivers every answer line to the request that owns its wire id, until the connection
// ends.
func (host *Host) readAnswers(held *link) {
	for {
		line, err := held.reader.ReadBytes('\n')
		if err != nil {
			host.dropLink(held, err)
			return
		}
		var answer controlwire.Response
		if err := json.Unmarshal(line, &answer); err != nil {
			host.dropLink(held, err)
			return
		}
		held.mu.Lock()
		call, found := held.pending[answer.ID]
		delete(held.pending, answer.ID)
		held.mu.Unlock()
		if found {
			answer.ID = call.id
			call.reply <- answer
		}
	}
}

// dropLink ends a connection and forgets it if it is still the unit's.
func (host *Host) dropLink(held *link, reason error) {
	held.shutdown(reason)
	host.mu.Lock()
	if host.links[held.name] == held {
		delete(host.links, held.name)
	}
	host.mu.Unlock()
}

// closeLinkLocked ends the held connection of a unit that left. Called with host.mu held; the
// link's own shutdown takes no host lock.
func (host *Host) closeLinkLocked(name string) {
	held := host.links[name]
	if held == nil {
		return
	}
	delete(host.links, name)
	held.shutdown(linkEnded(name))
}

func (held *link) isClosed() bool {
	held.mu.Lock()
	defer held.mu.Unlock()
	return held.closed
}

// shutdown closes the connection and fails every request still waiting on it. A caller left waiting
// on a socket nobody is on is the failure a held connection has to answer for.
func (held *link) shutdown(reason error) {
	held.mu.Lock()
	if held.closed {
		held.mu.Unlock()
		return
	}
	held.closed = true
	if reason == nil {
		reason = linkEnded(held.name)
	}
	held.failure = reason
	pending := held.pending
	held.pending = nil
	held.mu.Unlock()
	_ = held.conn.Close()
	for _, call := range pending {
		close(call.reply)
	}
}

// call writes one request under a relay-owned wire id and waits for its answer. written reports
// whether the request reached the connection.
func (held *link) call(request controlwire.Request) (answer controlwire.Response, written bool, err error) {
	held.mu.Lock()
	if held.closed {
		failure := held.failure
		held.mu.Unlock()
		return controlwire.Response{}, false, failure
	}
	held.next++
	wire := "relay-" + strconv.FormatUint(held.next, 10)
	call := pendingCall{id: request.ID, reply: make(chan controlwire.Response, 1)}
	held.pending[wire] = call
	held.mu.Unlock()

	onWire := request
	onWire.ID = wire
	held.write.Lock()
	err = json.NewEncoder(held.conn).Encode(onWire)
	held.write.Unlock()
	if err != nil {
		held.mu.Lock()
		delete(held.pending, wire)
		held.mu.Unlock()
		return controlwire.Response{}, false, err
	}
	answer, ok := <-call.reply
	if !ok {
		held.mu.Lock()
		failure := held.failure
		held.mu.Unlock()
		if failure == nil {
			failure = linkEnded(held.name)
		}
		return controlwire.Response{}, true, failure
	}
	return answer, true, nil
}

// exchange writes one request and reads one answer on an already greeted connection.
//
// The reader is the connection's own, made once and passed along. A second bufio.Reader over the
// same connection would start empty while the first still held bytes it had read ahead — and what
// that looks like is an answer that never arrives, on a unit that already sent it.
func exchange(
	conn io.Writer, reader *bufio.Reader, name string, request controlwire.Request,
) (controlwire.Response, error) {
	fail := func(err error) (controlwire.Response, error) {
		return controlwire.Response{}, i18n.Errorf("sidecar.noAnswer", map[string]string{
			"name": name, "reason": err.Error(),
		})
	}
	if err := json.NewEncoder(conn).Encode(request); err != nil {
		return fail(err)
	}
	line, err := reader.ReadBytes('\n')
	if err != nil {
		return fail(err)
	}
	var answer controlwire.Response
	if err := json.Unmarshal(line, &answer); err != nil {
		return fail(err)
	}
	return answer, nil
}

// Stream opens a connection, sends one request, and hands back what the unit writes after it.
//
// The first line is the unit's answer to the request; everything after it is bytes this host never
// looks at. Closing the returned reader ends the connection, which is how a caller that has gone
// away stops the unit writing into nothing.
func (host *Host) Stream(name string, request controlwire.Request) (controlwire.Response, io.ReadCloser, error) {
	conn, reader, _, err := host.connect(name)
	if err != nil {
		return controlwire.Response{}, nil, err
	}
	closed := true
	defer func() {
		if closed {
			_ = conn.Close()
		}
	}()

	answer, err := exchange(conn, reader, name, request)
	if err != nil {
		return controlwire.Response{}, nil, err
	}
	if !answer.Ok {
		// A refused stream request leaves no stream. Handing back a reader that will only ever see
		// the connection close would make a refusal look like a session with no output.
		return answer, nil, nil
	}
	closed = false
	return answer, &stream{reader: reader, conn: conn}, nil
}

// stream is the connection after its one answer: bytes, and the close that ends them.
type stream struct {
	reader *bufio.Reader
	conn   io.ReadWriteCloser
}

func (s *stream) Read(into []byte) (int, error) { return s.reader.Read(into) }
func (s *stream) Close() error                  { return s.conn.Close() }

// connect starts the unit if it is not running, opens a connection to the address it announced, and
// greets it.
//
// The greeting is per connection because that is what it agrees: a protocol and an identity for this
// exchange. Skipping it would leave a version mismatch to be discovered at the first command that
// behaves differently, which is halfway through answers the caller already trusted.
//
// The token is this host's to send. It arrived on the unit's announcement, which only the process
// that started the unit reads, and no caller ever sees it — a caller holding it could greet the
// unit directly, and this relay is the only thing between a plugin and a process.
func (host *Host) connect(name string) (io.ReadWriteCloser, *bufio.Reader, Open, error) {
	host.mu.Lock()
	held := host.open[name]
	host.mu.Unlock()
	if held == nil {
		// A unit this host held and lost is a unit that has to be there again for the caller that was
		// granted it. Starting it here is the same start that granted it, on the same settings; a name
		// the settings no longer carry fails at that start and the caller reads why.
		if _, err := host.restart(name); err != nil {
			return nil, nil, Open{}, err
		}
		host.mu.Lock()
		held = host.open[name]
		host.mu.Unlock()
	}
	if held == nil {
		return nil, nil, Open{}, i18n.Errorf("sidecar.notOpen", map[string]string{"name": name})
	}
	open := held.open
	if host.deps.Dial == nil {
		return nil, nil, Open{}, i18n.Errorf("sidecar.noDial", map[string]string{"name": name})
	}
	conn, err := host.deps.Dial(open.Address)
	if err != nil {
		return nil, nil, Open{}, i18n.Errorf("sidecar.dialFailed", map[string]string{
			"name": name, "address": open.Address, "reason": err.Error(),
		})
	}
	reader := bufio.NewReader(conn)
	if err := host.greet(conn, reader, name); err != nil {
		_ = conn.Close()
		return nil, nil, Open{}, err
	}
	return conn, reader, open, nil
}

// greet agrees a protocol on one connection before anything else travels on it.
func (host *Host) greet(conn io.Writer, reader *bufio.Reader, name string) error {
	host.mu.Lock()
	held := host.open[name]
	host.mu.Unlock()
	token := ""
	if held != nil {
		token = held.token
	}

	protocol, _ := json.Marshal(controlwire.Protocol)
	encoded, _ := json.Marshal(token)
	request := controlwire.Request{
		ID:      "greeting",
		Command: controlwire.HelloCommand,
		Args:    map[string]json.RawMessage{"protocol": protocol, "token": encoded},
	}
	answer, err := exchange(conn, reader, name, request)
	if err != nil {
		return err
	}
	if !answer.Ok {
		return i18n.Errorf("sidecar.greetingRefused", map[string]string{
			"name": name, "reason": answer.Error,
		})
	}
	return nil
}

// bufferedReader is the one reader a connection gets. A second over the same connection starts empty
// while the first still holds bytes it read ahead, and what that looks like is an answer that never
// arrives on a unit that already sent it.
func bufferedReader(conn io.ReadWriteCloser) *bufio.Reader { return bufio.NewReader(conn) }
