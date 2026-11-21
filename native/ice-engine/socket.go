package main

import (
	"context"
	"net"
	"strconv"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/stun/v4"
	"github.com/pion/transport/v5"
	"github.com/pion/webrtc/v4"
)

// The network and its mux move together from preparation into one session.
// A virtual network can supply its own interfaces, UDP binding and resolver.
type preparedSocket struct {
	ice.UDPMux
	tcp               ice.TCPMux
	listenPhysicalTCP func() ice.TCPMux
	network           transport.Net
	observations      <-chan observation
	cancel            context.CancelFunc
}

func prepareSocket(network transport.Net, servers []webrtc.ICEServer) (*preparedSocket, error) {
	socket, err := network.ListenUDP("udp", &net.UDPAddr{})
	if err != nil {
		return nil, err
	}
	_ = socket.SetReadBuffer(2 * 1024 * 1024)
	mux := ice.NewUniversalUDPMuxDefault(ice.UniversalUDPMuxParams{
		UDPConn: socket, Net: network, XORMappedAddrCacheTTL: time.Millisecond,
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	results := make(chan observation, 3)
	prepared := &preparedSocket{UDPMux: mux, network: network, cancel: cancel, observations: results}
	base := socket.LocalAddr().(*net.UDPAddr)
	go func() {
		defer cancel()
		defer close(results)
		observeMapped(ctx, network, mux, base.Port, 0, servers, results)
	}()
	return prepared, nil
}

func observeMapped(ctx context.Context, network transport.Net, mux *ice.UniversalUDPMuxDefault, basePort, socketID int, servers []webrtc.ICEServer, results chan<- observation) {
	seen := map[string]bool{}
	for _, server := range servers {
		for _, raw := range server.URLs {
			uri, e := stun.ParseURI(raw)
			if e != nil || uri.Scheme != stun.SchemeTypeSTUN || uri.Proto != stun.ProtoTypeUDP || seen[uri.String()] {
				continue
			}
			if len(seen) >= 3 || ctx.Err() != nil {
				return
			}
			seen[uri.String()] = true
			target, e := network.ResolveUDPAddr("udp4", net.JoinHostPort(uri.Host, strconv.Itoa(uri.Port)))
			if e != nil || ctx.Err() != nil {
				continue
			}
			deadline, _ := ctx.Deadline()
			remaining := min(time.Until(deadline), 1500*time.Millisecond)
			if remaining <= 0 {
				return
			}
			mapped, e := mux.GetXORMappedAddr(target, remaining)
			if e == nil && ctx.Err() == nil && mapped.IP.To4() != nil {
				select {
				case results <- observation{address: mapped.IP.String(), port: mapped.Port, source: len(seen) - 1, basePort: basePort, socketID: socketID}:
				case <-ctx.Done():
					return
				}
			}
		}
	}
}

// Each authenticated native negotiation owns its listener. A listener denied
// by the OS leaves the original UDP transport available.
func (s *preparedSocket) enableTCP() {
	if s.listenPhysicalTCP != nil {
		s.tcp = s.listenPhysicalTCP()
		return
	}
	listener, err := s.network.ListenTCP("tcp", &net.TCPAddr{})
	if err == nil {
		s.tcp = ice.NewTCPMuxDefault(ice.TCPMuxParams{Listener: listener, WriteBufferSize: 4 * 1024 * 1024})
	}
}

func (s *preparedSocket) Close() error {
	s.cancel()
	if s.tcp != nil {
		_ = s.tcp.Close()
	}
	return s.UDPMux.Close()
}

// Pion asks for a listener by local IP. A passive candidate must use the
// port of the listener bound to that address, including on dual-stack hosts.
type boundTCPMux map[string]*ice.TCPMuxDefault

func (m boundTCPMux) GetConnByUfrag(ufrag string, ipv6 bool, ip net.IP) (net.PacketConn, error) {
	if listener := m[ip.String()]; listener != nil {
		return listener.GetConnByUfrag(ufrag, ipv6, ip)
	}
	return nil, net.ErrClosed
}
func (m boundTCPMux) RemoveConnByUfrag(ufrag string) {
	for _, listener := range m {
		listener.RemoveConnByUfrag(ufrag)
	}
}
func (m boundTCPMux) Close() error {
	var first error
	for _, listener := range m {
		if err := listener.Close(); err != nil && first == nil {
			first = err
		}
	}
	return first
}

// Chromium can bind its ICE candidate to a physical interface even for a
// same-machine call. Accept and send bridge packets only on this machine.
type localPacketConn struct {
	net.PacketConn
	addresses map[string]bool
}

func newLocalPacketConn() (*localPacketConn, error) {
	interfaces, err := net.InterfaceAddrs()
	if err != nil {
		return nil, err
	}
	addresses := map[string]bool{"127.0.0.1": true}
	for _, addr := range interfaces {
		if subnet, ok := addr.(*net.IPNet); ok && subnet.IP.To4() != nil {
			addresses[subnet.IP.String()] = true
		}
	}
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4zero})
	if err != nil {
		return nil, err
	}
	return &localPacketConn{PacketConn: conn, addresses: addresses}, nil
}
func (s *localPacketConn) local(addr net.Addr) bool {
	udp, ok := addr.(*net.UDPAddr)
	return ok && (udp.IP.IsLoopback() || s.addresses[udp.IP.String()])
}
func (s *localPacketConn) ReadFrom(buf []byte) (int, net.Addr, error) {
	for {
		n, from, err := s.PacketConn.ReadFrom(buf)
		if err != nil || s.local(from) {
			return n, from, err
		}
	}
}
func (s *localPacketConn) WriteTo(buf []byte, to net.Addr) (int, error) {
	if !s.local(to) {
		return 0, net.ErrClosed
	}
	return s.PacketConn.WriteTo(buf, to)
}
