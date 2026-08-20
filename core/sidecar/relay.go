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
// The unit is started if it is not running. A caller asking a unit to do something is a caller who
// wants it running, and refusing because it is not would make every first call fail.
func (host *Host) Send(name string, request controlwire.Request) (controlwire.Response, error) {
	conn, open, err := host.connect(name)
	if err != nil {
		return controlwire.Response{}, err
	}
	defer func() { _ = conn.Close() }()

	if err := json.NewEncoder(conn).Encode(request); err != nil {
		return controlwire.Response{}, i18n.Errorf("sidecar.noAnswer", map[string]string{
			"name": open.Name, "reason": err.Error(),
		})
	}
	line, err := bufio.NewReader(conn).ReadBytes('\n')
	if err != nil {
		return controlwire.Response{}, i18n.Errorf("sidecar.noAnswer", map[string]string{
			"name": open.Name, "reason": err.Error(),
		})
	}
	var answer controlwire.Response
	if err := json.Unmarshal(line, &answer); err != nil {
		return controlwire.Response{}, i18n.Errorf("sidecar.noAnswer", map[string]string{
			"name": open.Name, "reason": err.Error(),
		})
	}
	return answer, nil
}

// Stream opens a connection, sends one request, and hands back what the unit writes after it.
//
// The first line is the unit's answer to the request; everything after it is bytes this host never
// looks at. Closing the returned reader ends the connection, which is how a caller that has gone
// away stops the unit writing into nothing.
func (host *Host) Stream(name string, request controlwire.Request) (controlwire.Response, io.ReadCloser, error) {
	conn, open, err := host.connect(name)
	if err != nil {
		return controlwire.Response{}, nil, err
	}
	closed := true
	defer func() {
		if closed {
			_ = conn.Close()
		}
	}()

	if err := json.NewEncoder(conn).Encode(request); err != nil {
		return controlwire.Response{}, nil, i18n.Errorf("sidecar.noAnswer", map[string]string{
			"name": open.Name, "reason": err.Error(),
		})
	}
	reader := bufio.NewReader(conn)
	line, err := reader.ReadBytes('\n')
	if err != nil {
		return controlwire.Response{}, nil, i18n.Errorf("sidecar.noAnswer", map[string]string{
			"name": open.Name, "reason": err.Error(),
		})
	}
	var answer controlwire.Response
	if err := json.Unmarshal(line, &answer); err != nil {
		return controlwire.Response{}, nil, i18n.Errorf("sidecar.noAnswer", map[string]string{
			"name": open.Name, "reason": err.Error(),
		})
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

// connect starts the unit if it is not running and opens a connection to the address it announced.
func (host *Host) connect(name string) (io.ReadWriteCloser, Open, error) {
	open, err := host.Start(name)
	if err != nil {
		return nil, Open{}, err
	}
	if host.deps.Dial == nil {
		return nil, Open{}, i18n.Errorf("sidecar.noDial", map[string]string{"name": name})
	}
	conn, err := host.deps.Dial(open.Address)
	if err != nil {
		return nil, Open{}, i18n.Errorf("sidecar.dialFailed", map[string]string{
			"name": name, "address": open.Address, "reason": err.Error(),
		})
	}
	return conn, open, nil
}
