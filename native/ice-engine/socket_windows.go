package main

import (
	"context"
	"errors"
	"math/bits"
	"net"
	"os"
	"sync"
	"syscall"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/transport/v5/stdnet"
	"github.com/pion/webrtc/v4"
	"golang.org/x/sys/windows"
)

// Do not infer a physical interface from its name, MAC address or address
// range. NDIS reports the hardware bit for Wi-Fi, Ethernet and mobile NICs.
func hardwareInterface(iface net.Interface) bool {
	if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
		return false
	}
	row := windows.MibIfRow2{InterfaceIndex: uint32(iface.Index)}
	return windows.GetIfEntry2Ex(windows.MibIfEntryNormalWithoutStatistics, &row) == nil &&
		row.InterfaceAndOperStatusFlags&1 != 0 && row.OperStatus == windows.IfOperStatusUp
}

func physicalListenConfig(ip net.IP, index int) net.ListenConfig {
	level, value := windows.IPPROTO_IPV6, index
	if ip.To4() != nil {
		// Winsock expects the IPv4 interface index in network byte order;
		// its IPv6 counterpart takes the index in host byte order.
		level, value = windows.IPPROTO_IP, int(bits.ReverseBytes32(uint32(index)))
	}
	const unicastInterface = 31 // IP_UNICAST_IF / IPV6_UNICAST_IF
	return net.ListenConfig{Control: func(_, _ string, raw syscall.RawConn) error {
		var optionErr error
		err := raw.Control(func(fd uintptr) {
			optionErr = windows.SetsockoptInt(windows.Handle(fd), level, unicastInterface, value)
		})
		if err != nil {
			return err
		}
		return optionErr
	}}
}

func prepareSystemSocket(servers []webrtc.ICEServer) (*preparedSocket, error) {
	network, err := stdnet.NewNet()
	if err != nil {
		return nil, err
	}
	if os.Getenv("ROOMCAST_PHYSICAL_DIRECT") != "1" {
		return prepareSocket(network, servers)
	}
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	results := make(chan observation, 3*len(ifaces))
	var surveys sync.WaitGroup
	var muxes []ice.UDPMux
	addresses := make(map[string]int)
	for _, iface := range ifaces {
		if !hardwareInterface(iface) {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		resolve := physicalStunResolver(uint32(iface.Index), network.ResolveUDPAddr)
		for _, addr := range addrs {
			subnet, ok := addr.(*net.IPNet)
			if !ok || !subnet.IP.IsGlobalUnicast() || subnet.IP.IsLinkLocalUnicast() {
				continue
			}
			config := physicalListenConfig(subnet.IP, iface.Index)
			conn, err := config.ListenPacket(ctx, "udp", net.JoinHostPort(subnet.IP.String(), "0"))
			if err != nil {
				continue
			}
			socket := conn.(*net.UDPConn)
			_ = socket.SetReadBuffer(2 * 1024 * 1024)
			mux := ice.NewUniversalUDPMuxDefault(ice.UniversalUDPMuxParams{UDPConn: socket, Net: network, XORMappedAddrCacheTTL: time.Millisecond})
			muxes = append(muxes, mux)
			addresses[subnet.IP.String()] = iface.Index
			if subnet.IP.To4() != nil {
				socketID := len(muxes)
				surveys.Add(1)
				go func() {
					defer surveys.Done()
					observeMapped(ctx, resolve, mux, socket.LocalAddr().(*net.UDPAddr).Port, socketID, servers, results)
				}()
			}
		}
	}
	if len(muxes) == 0 {
		cancel()
		return nil, errors.New("no-physical-network-address")
	}
	go func() { surveys.Wait(); close(results) }()
	listenTCP := func() ice.TCPMux {
		listeners := boundTCPMux{}
		for address, index := range addresses {
			config := physicalListenConfig(net.ParseIP(address), index)
			listener, err := config.Listen(context.Background(), "tcp", net.JoinHostPort(address, "0"))
			if err == nil {
				listeners[address] = ice.NewTCPMuxDefault(ice.TCPMuxParams{Listener: listener, WriteBufferSize: 4 * 1024 * 1024})
			}
		}
		if len(listeners) == 0 {
			return nil
		}
		return listeners
	}
	return &preparedSocket{UDPMux: ice.NewMultiUDPMuxDefault(muxes...), listenPhysicalTCP: listenTCP, network: network, cancel: cancel, observations: results}, nil
}
