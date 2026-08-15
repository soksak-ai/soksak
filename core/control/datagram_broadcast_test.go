package control

import (
	"net"
	"strings"
	"testing"
)

// segment is one network this host would sit on, as InterfaceAddrs reports it.
func segment(cidr string) *net.IPNet {
	address, network, err := net.ParseCIDR(cidr)
	if err != nil {
		panic(err)
	}
	// InterfaceAddrs reports the interface's own address with the network's
	// mask, not the network address. The rule has to work on that shape.
	return &net.IPNet{IP: address, Mask: network.Mask}
}

func TestABroadcastNobodyAskedForIsRefused(t *testing.T) {
	// Go sets SO_BROADCAST on every UDP socket it opens, so the kernel lets
	// this through (measured 2026-08-15). Nothing else is between a mistyped
	// host and every machine on the segment.
	local := []net.Addr{segment("192.168.1.10/24"), segment("127.0.0.1/8")}

	for _, target := range []string{"255.255.255.255", "192.168.1.255", "127.255.255.255"} {
		destination := &net.UDPAddr{IP: net.ParseIP(target), Port: 9}
		if !isDirectedBroadcast(destination.IP.To4(), local) && target != "255.255.255.255" {
			t.Errorf("%s is the broadcast address of a network this host is on and was not read as one", target)
		}
		if err := guardBroadcast(destination, true); err != nil {
			t.Errorf("%s was named and still refused: %v", target, err)
		}
	}

	// The limited broadcast address needs no interface at all.
	err := guardBroadcast(&net.UDPAddr{IP: net.IPv4bcast, Port: 9}, false)
	if err == nil {
		t.Fatal("255.255.255.255 was accepted from a caller that named no broadcast")
	}
	if !strings.Contains(err.Error(), `"broadcast":true`) {
		t.Errorf("the refusal reads %q and does not say what to send instead", err)
	}
}

func TestAnOrdinaryAddressIsNotMistakenForABroadcast(t *testing.T) {
	// A rule that refused too much would make every unicast send fail, and the
	// caller would carry a broadcast flag it does not mean.
	local := []net.Addr{segment("192.168.1.10/24"), segment("10.0.0.7/32")}

	for _, target := range []string{"192.168.1.11", "192.168.2.255", "10.0.0.7", "8.8.8.8"} {
		if isDirectedBroadcast(net.ParseIP(target).To4(), local) {
			t.Errorf("%s was read as a broadcast address", target)
		}
	}
}

func TestAMistypedBroadcastIsRefusedThroughTheRegistry(t *testing.T) {
	// No datagram leaves: the refusal happens before the socket is opened, so
	// this test never reaches the local network.
	_, err := datagramRegistry(t).Invoke(commandDatagramSend, argsOf(t, map[string]any{
		"host": "255.255.255.255", "port": 9, "data": []int{0xff},
	}))
	if err == nil {
		t.Fatal("a broadcast nobody asked for was sent")
	}
	if !strings.Contains(err.Error(), "every machine on the segment") {
		t.Errorf("the refusal reads %q", err)
	}

	// The collection command carries the same rule; a discovery sweep is not a
	// smaller decision than a single datagram.
	if _, err := datagramRegistry(t).Invoke(commandDatagramRequest, argsOf(t, map[string]any{
		"host": "255.255.255.255", "port": 9, "data": []int{0xff},
	})); err == nil {
		t.Fatal("net_udp_request broadcast without being asked")
	}
}
