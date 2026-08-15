package control

import (
	"errors"
	"fmt"
	"net"
	"os"
	"strconv"
	"time"

	"github.com/soksak/soksak-core/core/i18n"
)

// Raw UDP, which a webview cannot do at all.
//
// The socket is unconnected in both commands. A connected UDP socket drops
// every datagram that did not come from the peer it dialled, and discovery
// replies do not: an SSDP search goes to 239.255.255.250 and each device
// answers from its own address. Dialling would have collected nothing and
// reported it as "nobody answered".

const (
	// defaultCollectWindow is how long net_udp_request listens when the caller
	// names no window. It matches the frontend's own default so the two agree
	// about what "no answer" means.
	defaultCollectWindow = 3000
	// defaultMaxPackets bounds one collection. Discovery on a busy network
	// answers indefinitely, and a reply that never ends is a reply that never
	// arrives.
	defaultMaxPackets = 64
	// maxDatagramBytes is the largest UDP payload IPv4 can carry, so a read
	// never truncates a datagram that the network delivered whole.
	maxDatagramBytes = 65535
)

// Datagram is one packet that came back.
//
// Data is []int rather than []byte because encoding/json writes a []byte as a
// base64 string. The caller decodes these bytes to hex and to text, and would
// have received a string that hexes to the base64 of the real payload —
// plausible-looking and wrong.
type Datagram struct {
	Address string `json:"address"`
	Port    int    `json:"port"`
	Data    []int  `json:"data"`
}

func registerDatagram(registry *Registry) {
	registry.MustRegister(Command{
		Name:    commandDatagramSend,
		Owner:   OwnerCore,
		Handler: sendDatagram,
	})
	registry.MustRegister(Command{
		Name:    commandDatagramRequest,
		Owner:   OwnerCore,
		Handler: requestDatagrams,
	})
}

func sendDatagram(args Args) (any, error) {
	destination, err := datagramDestination(args)
	if err != nil {
		return nil, err
	}
	payload, err := datagramPayload(args)
	if err != nil {
		return nil, err
	}
	broadcast, err := OptionalArg(args, "broadcast", false)
	if err != nil {
		return nil, err
	}
	if err := guardBroadcast(destination, broadcast); err != nil {
		return nil, err
	}

	socket, err := openDatagramSocket()
	if err != nil {
		return nil, err
	}
	defer func() { _ = socket.Close() }()

	sent, err := socket.WriteTo(payload, destination)
	if err != nil {
		return nil, fmt.Errorf("sending %d byte(s) to %s: %w", len(payload), destination, err)
	}
	return sent, nil
}

func requestDatagrams(args Args) (any, error) {
	destination, err := datagramDestination(args)
	if err != nil {
		return nil, err
	}
	payload, err := datagramPayload(args)
	if err != nil {
		return nil, err
	}
	// The caller owns the window. It is not capped here: a cap would return
	// early with fewer packets than were asked for, which reads as "the
	// network went quiet" rather than as "this build stopped listening".
	window, err := OptionalArg(args, "timeoutMs", defaultCollectWindow)
	if err != nil {
		return nil, err
	}
	if window <= 0 {
		return nil, i18n.Errorf("control.datagram.windowTooSmall", map[string]string{"name": "timeoutMs", "value": strconv.Itoa(window)})
	}
	limit, err := OptionalArg(args, "maxPackets", defaultMaxPackets)
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		return nil, i18n.Errorf("control.datagram.packetLimitTooSmall", map[string]string{"name": "maxPackets", "value": strconv.Itoa(limit)})
	}
	broadcast, err := OptionalArg(args, "broadcast", false)
	if err != nil {
		return nil, err
	}
	if err := guardBroadcast(destination, broadcast); err != nil {
		return nil, err
	}

	socket, err := openDatagramSocket()
	if err != nil {
		return nil, err
	}
	defer func() { _ = socket.Close() }()

	if _, err := socket.WriteTo(payload, destination); err != nil {
		return nil, fmt.Errorf("sending %d byte(s) to %s: %w", len(payload), destination, err)
	}
	// One deadline for the whole collection, set before the first read. The
	// alternative is a loop that tests whether time has passed, and this package
	// does not poll.
	if err := socket.SetReadDeadline(time.Now().Add(time.Duration(window) * time.Millisecond)); err != nil {
		return nil, fmt.Errorf("arming the %dms collection window: %w", window, err)
	}

	// Never nil. A nil slice encodes as null, and the caller maps over this
	// answer: "nothing replied" would arrive as a crash rather than as zero
	// packets.
	//
	// The capacity is the default rather than the caller's limit, which the
	// caller chooses: reserving room for a limit of a million would let one
	// argument allocate what the process never receives. Append grows it if the
	// packets actually arrive.
	packets := make([]Datagram, 0, defaultMaxPackets)
	buffer := make([]byte, maxDatagramBytes)
	for len(packets) < limit {
		read, from, err := socket.ReadFrom(buffer)
		// A read that returned without error delivered a datagram, and a
		// zero-length datagram is one of them: some protocols answer with an
		// empty packet, and counting it by its length would report that
		// responder as silent.
		if err == nil || read > 0 {
			packet, packetErr := datagramFrom(from, buffer[:read])
			if packetErr != nil {
				return nil, packetErr
			}
			packets = append(packets, packet)
		}
		if err != nil {
			if errors.Is(err, os.ErrDeadlineExceeded) {
				// The window closed. That is the end of the collection, not a
				// failure: everything gathered so far is the answer.
				break
			}
			return nil, fmt.Errorf("collecting replies from %s: %w", destination, err)
		}
	}
	return packets, nil
}

func datagramFrom(from net.Addr, payload []byte) (Datagram, error) {
	sender, isUDP := from.(*net.UDPAddr)
	if !isUDP {
		return Datagram{}, i18n.Errorf("control.datagram.replyNotUDP", map[string]string{"address": from.String()})
	}
	data := make([]int, len(payload))
	for index, value := range payload {
		data[index] = int(value)
	}
	return Datagram{Address: sender.IP.String(), Port: sender.Port, Data: data}, nil
}

// openDatagramSocket takes an ephemeral local port.
//
// Replies come back to it, which is why net_udp_request sends and listens on
// one socket: a second socket would have a different port and the unicast
// answers would go to the first.
func openDatagramSocket() (net.PacketConn, error) {
	socket, err := net.ListenPacket("udp", ":0")
	if err != nil {
		return nil, fmt.Errorf("opening a UDP socket: %w", err)
	}
	return socket, nil
}

// guardBroadcast refuses a broadcast the caller did not ask for.
//
// The kernel does not ask. Measured 2026-08-15: a socket from
// net.ListenPacket("udp", ":0") already has SO_BROADCAST set, and Go's
// net/sockopt_{bsd,linux,windows}.go set it unconditionally for every
// SOCK_DGRAM — so there is no EACCES to lean on and no platform difference to
// carry. A `broadcast` flag that only set an option already set would have been
// a no-op the caller could not tell from a working permission check.
//
// The rule that is left is the one worth having: a host that resolves to a
// broadcast address is delivered to every machine on the segment, and a caller
// who did not state that almost certainly mistyped. Wake-on-LAN states it.
func guardBroadcast(destination *net.UDPAddr, named bool) error {
	if named {
		return nil
	}
	target := destination.IP.To4()
	if target == nil {
		// IPv6 has no broadcast address; multicast is what replaces it, and
		// multicast is ordinary traffic that needs no declaration.
		return nil
	}
	if target.Equal(net.IPv4bcast) {
		return broadcastRefused(destination)
	}
	local, err := net.InterfaceAddrs()
	if err != nil {
		// Without the netmasks a directed broadcast is indistinguishable from a
		// unicast, and guessing here is the one thing this check exists to stop.
		return fmt.Errorf("this process could not read its own interfaces, so it cannot tell whether %s is a broadcast address: %w",
			destination.IP, err)
	}
	if isDirectedBroadcast(target, local) {
		return broadcastRefused(destination)
	}
	return nil
}

func broadcastRefused(destination *net.UDPAddr) error {
	return i18n.Errorf("control.datagram.broadcastRefused", map[string]string{
		"address": destination.IP.String(),
		"name":    "broadcast",
	})
}

// isDirectedBroadcast answers whether target is the broadcast address of one of
// the networks this host is on.
//
// The interfaces are an argument so the rule can be held by a test: a check
// that could only be exercised against whatever networks the machine happened
// to be on would be a check nothing pins.
func isDirectedBroadcast(target net.IP, local []net.Addr) bool {
	for _, address := range local {
		network, isNetwork := address.(*net.IPNet)
		if !isNetwork {
			continue
		}
		base := network.IP.To4()
		if base == nil {
			continue
		}
		mask := network.Mask
		if len(mask) == net.IPv6len {
			mask = mask[12:]
		}
		if len(mask) != net.IPv4len {
			continue
		}
		broadcast := make(net.IP, net.IPv4len)
		for index := range broadcast {
			broadcast[index] = base[index] | ^mask[index]
		}
		// A /32 is one address that is also its own "broadcast". Treating it as
		// one would refuse every send to a point-to-point peer.
		if broadcast.Equal(base) {
			continue
		}
		if broadcast.Equal(target) {
			return true
		}
	}
	return false
}

func datagramDestination(args Args) (*net.UDPAddr, error) {
	host, err := Arg[string](args, "host")
	if err != nil {
		return nil, err
	}
	if host == "" {
		return nil, i18n.Errorf("control.datagram.hostEmpty", map[string]string{"name": "host"})
	}
	port, err := Arg[int](args, "port")
	if err != nil {
		return nil, err
	}
	// Port 0 is refused rather than resolved. It means "any port" to a socket
	// being bound and nothing at all to a destination, so a send to it leaves
	// on the wire and is answered by nobody.
	if port < 1 || port > 65535 {
		return nil, i18n.Errorf("control.datagram.portRange", map[string]string{"name": "port", "value": strconv.Itoa(port)})
	}
	destination, err := net.ResolveUDPAddr("udp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return nil, fmt.Errorf("%s could not be resolved: %w", net.JoinHostPort(host, strconv.Itoa(port)), err)
	}
	return destination, nil
}

// datagramPayload reads the bytes to send.
//
// They arrive as an array of numbers because that is what the caller has after
// decoding its hex, and a JSON number outside 0..255 is refused by index
// rather than truncated: a payload silently altered by one byte is a datagram
// that arrives and means something else.
func datagramPayload(args Args) ([]byte, error) {
	values, err := Arg[[]int](args, "data")
	if err != nil {
		return nil, err
	}
	payload := make([]byte, len(values))
	for index, value := range values {
		if value < 0 || value > 255 {
			return nil, i18n.Errorf("control.datagram.byteRange", map[string]string{
				"name":  "data",
				"index": strconv.Itoa(index),
				"value": strconv.Itoa(value),
			})
		}
		payload[index] = byte(value)
	}
	return payload, nil
}
