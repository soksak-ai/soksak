package control

import (
	"encoding/json"
	"net"
	"strings"
	"testing"
	"time"
)

// datagramRegistry is a build that was given nothing. The datagram commands
// need nothing from the process, and that is part of the contract.
func datagramRegistry(t *testing.T) *Registry {
	t.Helper()
	registry := NewRegistry()
	Register(registry, Deps{})
	return registry
}

func listenLocal(t *testing.T) (net.PacketConn, int) {
	t.Helper()
	socket, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("opening a local UDP socket: %v", err)
	}
	t.Cleanup(func() { _ = socket.Close() })
	return socket, socket.LocalAddr().(*net.UDPAddr).Port
}

func TestSendDeliversExactlyTheBytesItWasGiven(t *testing.T) {
	target, port := listenLocal(t)

	answer, err := datagramRegistry(t).Invoke(commandDatagramSend, argsOf(t, map[string]any{
		"host": "127.0.0.1",
		"port": port,
		"data": []int{0xff, 0x00, 0x02},
	}))
	if err != nil {
		t.Fatalf("net_udp_send: %v", err)
	}
	if answer != 3 {
		t.Errorf("bytesSent = %v, want 3", answer)
	}

	buffer := make([]byte, 64)
	if err := target.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatalf("arming the read: %v", err)
	}
	read, _, err := target.ReadFrom(buffer)
	if err != nil {
		t.Fatalf("the datagram never arrived: %v", err)
	}
	if got := buffer[:read]; string(got) != string([]byte{0xff, 0x00, 0x02}) {
		t.Errorf("delivered % x, want ff 00 02", got)
	}
}

func TestAByteOutsideItsRangeIsRefusedByIndex(t *testing.T) {
	// Truncating to a byte would send a datagram that arrives and means
	// something else, which no error downstream would ever attribute to here.
	_, err := datagramRegistry(t).Invoke(commandDatagramSend, argsOf(t, map[string]any{
		"host": "127.0.0.1", "port": 9, "data": []int{0x01, 256},
	}))
	if err == nil {
		t.Fatal("256 is not a byte")
	}
	if !strings.Contains(err.Error(), "element 1") {
		t.Errorf("the failure reads %q and does not say which element", err)
	}
}

func TestPortZeroIsRefusedRatherThanResolved(t *testing.T) {
	// Port 0 means "any port" to a socket being bound and nothing at all to a
	// destination: the datagram leaves and is answered by nobody.
	for _, port := range []int{0, 65536} {
		_, err := datagramRegistry(t).Invoke(commandDatagramSend, argsOf(t, map[string]any{
			"host": "127.0.0.1", "port": port, "data": []int{1},
		}))
		if err == nil {
			t.Errorf("port %d was accepted", port)
		}
	}
}

func TestRequestCollectsRepliesFromWhoeverAnswers(t *testing.T) {
	// A connected UDP socket drops every datagram that did not come from the
	// peer it dialled. Discovery replies come from each device's own address,
	// so dialling would collect nothing and report it as "nobody answered".
	target, port := listenLocal(t)
	replied := make(chan int, 1)
	go func() {
		buffer := make([]byte, 1500)
		if err := target.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
			return
		}
		_, from, err := target.ReadFrom(buffer)
		if err != nil {
			return
		}
		replier, err := net.ListenPacket("udp", "127.0.0.1:0")
		if err != nil {
			return
		}
		defer func() { _ = replier.Close() }()
		if _, err := replier.WriteTo([]byte("HI"), from); err != nil {
			return
		}
		replied <- replier.LocalAddr().(*net.UDPAddr).Port
	}()

	answer, err := datagramRegistry(t).Invoke(commandDatagramRequest, argsOf(t, map[string]any{
		"host": "127.0.0.1", "port": port, "data": []int{0x4d, 0x2d},
		"timeoutMs": 2000, "maxPackets": 1,
	}))
	if err != nil {
		t.Fatalf("net_udp_request: %v", err)
	}
	packets, ok := answer.([]Datagram)
	if !ok {
		t.Fatalf("net_udp_request answered %T", answer)
	}
	if len(packets) != 1 {
		t.Fatalf("collected %d packet(s), want 1", len(packets))
	}
	if packets[0].Address != "127.0.0.1" {
		t.Errorf("reply came from %q", packets[0].Address)
	}
	select {
	case from := <-replied:
		if packets[0].Port != from {
			t.Errorf("reply port = %d, want the answering socket's %d", packets[0].Port, from)
		}
	case <-time.After(time.Second):
		t.Fatal("the responder never reported which socket it answered from")
	}
	if len(packets[0].Data) != 2 || packets[0].Data[0] != 72 || packets[0].Data[1] != 73 {
		t.Errorf("payload = %v, want [72 73]", packets[0].Data)
	}
}

func TestPacketBytesArriveAsNumbersRatherThanBase64(t *testing.T) {
	// encoding/json writes a []byte as a base64 string. The caller hexes these
	// bytes; it would have received a string that hexes to the base64 of the
	// real payload — plausible-looking and wrong.
	encoded, err := json.Marshal(Datagram{Address: "127.0.0.1", Port: 1900, Data: []int{72, 73}})
	if err != nil {
		t.Fatalf("encoding a packet: %v", err)
	}
	if !strings.Contains(string(encoded), `"data":[72,73]`) {
		t.Errorf("a packet encodes as %s", encoded)
	}
}

func TestNobodyAnsweringIsAnEmptyListRatherThanNull(t *testing.T) {
	// A nil slice encodes as null and the caller maps over this answer, so
	// "nothing replied" would arrive as a crash rather than as zero packets.
	_, port := listenLocal(t)

	answer, err := datagramRegistry(t).Invoke(commandDatagramRequest, argsOf(t, map[string]any{
		"host": "127.0.0.1", "port": port, "data": []int{1}, "timeoutMs": 50,
	}))
	if err != nil {
		t.Fatalf("net_udp_request: %v", err)
	}
	encoded, err := json.Marshal(answer)
	if err != nil {
		t.Fatalf("encoding the answer: %v", err)
	}
	if string(encoded) != "[]" {
		t.Errorf("a collection nobody answered encodes as %s, want []", encoded)
	}
}

func TestACollectionStopsAtTheLimitItWasGiven(t *testing.T) {
	target, port := listenLocal(t)
	go func() {
		buffer := make([]byte, 1500)
		if err := target.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
			return
		}
		_, from, err := target.ReadFrom(buffer)
		if err != nil {
			return
		}
		for index := 0; index < 4; index++ {
			if _, err := target.WriteTo([]byte{byte(index)}, from); err != nil {
				return
			}
		}
	}()

	answer, err := datagramRegistry(t).Invoke(commandDatagramRequest, argsOf(t, map[string]any{
		"host": "127.0.0.1", "port": port, "data": []int{1},
		"timeoutMs": 2000, "maxPackets": 2,
	}))
	if err != nil {
		t.Fatalf("net_udp_request: %v", err)
	}
	if packets := answer.([]Datagram); len(packets) != 2 {
		t.Errorf("collected %d packet(s) under a limit of 2", len(packets))
	}
}

func TestACollectionWindowThatCannotCollectIsRefused(t *testing.T) {
	// Zero would send the datagram and return before any reply could arrive,
	// which reads as "nothing answered" rather than as "you asked for nothing".
	for name, value := range map[string]any{"timeoutMs": 0, "maxPackets": 0} {
		_, err := datagramRegistry(t).Invoke(commandDatagramRequest, argsOf(t, map[string]any{
			"host": "127.0.0.1", "port": 9, "data": []int{1}, name: value,
		}))
		if err == nil {
			t.Errorf("%s=0 was accepted", name)
		}
	}
}

func TestAnOmittedOptionIsTheDefaultRatherThanZero(t *testing.T) {
	// The transport sends null for an option the caller left out, and Go's json
	// treats null as a no-op: a required-looking option would decode to zero and
	// this build would refuse every default collection as "at least 1ms".
	target, port := listenLocal(t)
	go func() {
		buffer := make([]byte, 1500)
		if err := target.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
			return
		}
		if _, from, err := target.ReadFrom(buffer); err == nil {
			_, _ = target.WriteTo([]byte{7}, from)
		}
	}()

	// An omitted window takes the default rather than zero. The limit of one
	// closes the collection on the reply, so this proves the window was armed
	// without waiting the whole of it out.
	answer, err := datagramRegistry(t).Invoke(commandDatagramRequest, argsOf(t, map[string]any{
		"host": "127.0.0.1", "port": port, "data": []int{1},
		"timeoutMs": nil, "maxPackets": 1,
	}))
	if err != nil {
		t.Fatalf("net_udp_request with an omitted window: %v", err)
	}
	if packets := answer.([]Datagram); len(packets) != 1 {
		t.Fatalf("collected %d packet(s), want 1", len(packets))
	}

	// An omitted limit takes the default rather than zero.
	if _, err := datagramRegistry(t).Invoke(commandDatagramRequest, argsOf(t, map[string]any{
		"host": "127.0.0.1", "port": port, "data": []int{1},
		"timeoutMs": 50, "maxPackets": nil,
	})); err != nil {
		t.Fatalf("net_udp_request with an omitted limit: %v", err)
	}

	sent, err := datagramRegistry(t).Invoke(commandDatagramSend, argsOf(t, map[string]any{
		"host": "127.0.0.1", "port": port, "data": []int{1}, "broadcast": nil,
	}))
	if err != nil {
		t.Fatalf("net_udp_send with an omitted broadcast: %v", err)
	}
	if sent != 1 {
		t.Errorf("bytesSent = %v, want 1", sent)
	}
}

func TestAnEmptyReplyIsAReplyRatherThanSilence(t *testing.T) {
	// Some protocols answer with a zero-length datagram. Counting a packet by
	// its length would report that responder as one that never answered, which
	// is the difference between "no" and "nothing there".
	target, port := listenLocal(t)
	go func() {
		buffer := make([]byte, 1500)
		if err := target.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
			return
		}
		if _, from, err := target.ReadFrom(buffer); err == nil {
			_, _ = target.WriteTo(nil, from)
		}
	}()

	answer, err := datagramRegistry(t).Invoke(commandDatagramRequest, argsOf(t, map[string]any{
		"host": "127.0.0.1", "port": port, "data": []int{1},
		"timeoutMs": 2000, "maxPackets": 1,
	}))
	if err != nil {
		t.Fatalf("net_udp_request: %v", err)
	}
	packets := answer.([]Datagram)
	if len(packets) != 1 {
		t.Fatalf("collected %d packet(s) from a responder that answered empty", len(packets))
	}
	if len(packets[0].Data) != 0 {
		t.Errorf("payload = %v, want an empty one", packets[0].Data)
	}
}
