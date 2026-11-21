package main

import (
	"errors"
	"net"
	"strconv"
	"unsafe"

	"golang.org/x/sys/windows"
)

var dnsQueryEx = windows.NewLazySystemDLL("dnsapi.dll").NewProc("DnsQueryEx")

// WinDNS.h DNS_QUERY_REQUEST/RESULT, version 1. A nil callback makes the
// interface-scoped query synchronous on the existing STUN survey goroutine.
type dnsQueryRequest struct {
	version   uint32
	name      *uint16
	queryType uint16
	options   uint64
	servers   uintptr
	ifIndex   uint32
	callback  uintptr
	context   uintptr
}

type dnsQueryResult struct {
	version  uint32
	status   int32
	options  uint64
	records  *windows.DNSRecord
	reserved uintptr
}

func queryIPv4OnInterface(host string, index uint32) net.IP {
	name, err := windows.UTF16PtrFromString(host)
	if err != nil {
		return nil
	}
	const bypassCache, treatAsFQDN = 0x8, 0x1000
	request := dnsQueryRequest{version: 1, name: name, queryType: windows.DNS_TYPE_A,
		options: bypassCache | treatAsFQDN, ifIndex: index}
	result := dnsQueryResult{version: 1}
	status, _, _ := dnsQueryEx.Call(uintptr(unsafe.Pointer(&request)), uintptr(unsafe.Pointer(&result)), 0)
	if result.records != nil {
		defer windows.DnsRecordListFree(result.records, 1) // DnsFreeRecordList
	}
	if status != 0 || result.status != 0 {
		return nil
	}
	for record := result.records; record != nil; record = record.Next {
		if record.Type == windows.DNS_TYPE_A && record.Length == net.IPv4len {
			data := record.Data
			ip := net.IPv4(data[0], data[1], data[2], data[3])
			if directStunIPv4(ip) {
				return ip
			}
		}
	}
	return nil
}

func directStunIPv4(ip net.IP) bool {
	v4 := ip.To4()
	// The commonly used TUN fake-IP pool is unreachable through a physical socket.
	return v4 != nil && !(v4[0] == 198 && (v4[1] == 18 || v4[1] == 19))
}

func physicalStunResolver(index uint32, fallback func(string, string) (*net.UDPAddr, error)) func(string, string) (*net.UDPAddr, error) {
	return func(network, address string) (*net.UDPAddr, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		if net.ParseIP(host) == nil {
			if ip := queryIPv4OnInterface(host, index); ip != nil {
				port, err := strconv.Atoi(port)
				if err != nil {
					return nil, err
				}
				return &net.UDPAddr{IP: ip, Port: port}, nil
			}
		}
		// Strict TUN policies may block ordinary DNS on the adapter. An
		// address returned by the system is usable if it is a real IPv4 target.
		target, err := fallback(network, address)
		if err == nil && !directStunIPv4(target.IP) {
			return nil, errors.New("invalid-physical-stun-address")
		}
		return target, err
	}
}
