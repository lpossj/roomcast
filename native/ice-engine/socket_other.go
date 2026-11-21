//go:build !windows

package main

import (
	"github.com/pion/transport/v5/stdnet"
	"github.com/pion/webrtc/v4"
)

func prepareSystemSocket(servers []webrtc.ICEServer) (*preparedSocket, error) {
	network, err := stdnet.NewNet()
	if err != nil {
		return nil, err
	}
	return prepareSocket(network, servers)
}
