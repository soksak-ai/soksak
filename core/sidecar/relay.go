package sidecar

import (
	"bufio"
	"encoding/json"
	"io"

	controlwire "github.com/soksak/soksak-contract-control"
	"github.com/soksak/soksak-core/core/i18n"
)

// The relay. What crosses it is opaque.
//
// A request goes out as it arrived and an answer comes back as it was given. The meaning is a
// contract between the plugin that declared the unit and the unit itself, and a host that read it
// would need editing for every unit anyone writes — which is the lock-in the substrate exists to
// prevent.
//
// One connection per exchange rather than one held open per unit. A held connection is state this
// host would have to keep correct across a unit that restarts, a caller that goes away and a request
// that never answers, and every one of those is a way to leave a caller waiting on a socket nobody
// is on. Opening costs a connect on a local address, which is what the announcement already proved
// is there.

// Send takes one request to a unit and answers with what came back.
//
// A unit that is not open is refused rather than started. Opening is where the declaration is
// checked — that the caller declared this unit, and that the unit implements the contract that was
// declared — and a send that started one would be a way past both checks.
func (host *Host) Send(name string, request controlwire.Request) (controlwire.Response, error) {
	conn, reader, _, err := host.connect(name)
	if err != nil {
		return controlwire.Response{}, err
	}
	defer func() { _ = conn.Close() }()
	return exchange(conn, reader, name, request)
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
