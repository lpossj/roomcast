package main

import (
	"context"
	"encoding/base64"
	"errors"
	"net"

	"github.com/pion/ice/v4"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// Each logical room message may contain a binary image chunk or a room snapshot.
// SCTP is reliable and ordered. One prefix byte marks the last fragment.
const fragmentSize = 12 * 1024
const maxRoomMessage = 8 * 1024 * 1024

func (p *peer) bindControl(dc *webrtc.DataChannel) {
	p.mu.Lock()
	if p.control != nil || dc.Label() != "roomcast-v2" || !dc.Ordered() || dc.MaxRetransmits() != nil || dc.MaxPacketLifeTime() != nil {
		p.mu.Unlock()
		_ = dc.Close()
		return
	}
	p.control = dc
	p.mu.Unlock()
	dc.SetBufferedAmountLowThreshold(16 * 1024)
	dc.OnBufferedAmountLow(func() { emit(map[string]any{"id": p.id, "event": "buffer", "amount": dc.BufferedAmount()}) })
	dc.OnOpen(func() { emit(map[string]any{"id": p.id, "event": "open"}) })
	dc.OnClose(func() {
		if !p.closed.Load() {
			emit(map[string]any{"id": p.id, "event": "channel-close"})
		}
	})
	var pending []byte
	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		if len(m.Data) < 2 || len(m.Data) > fragmentSize+1 || m.Data[0] > 1 || len(pending)+len(m.Data)-1 > maxRoomMessage {
			failure(p.id, "invalid-room-message")
			_ = dc.Close()
			return
		}
		pending = append(pending, m.Data[1:]...)
		if m.Data[0] == 1 {
			emit(map[string]any{"id": p.id, "event": "data", "data": base64.StdEncoding.EncodeToString(pending)})
			pending = nil
		}
	})
}

func (p *peer) sendControl(encoded string) error {
	p.mu.Lock()
	dc := p.control
	p.mu.Unlock()
	if dc == nil || dc.ReadyState() != webrtc.DataChannelStateOpen {
		return errors.New("control-not-open")
	}
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(raw) == 0 || len(raw) > maxRoomMessage || dc.BufferedAmount()+uint64(len(raw)) > 2*maxRoomMessage {
		return errors.New("control-buffer-limit")
	}
	for len(raw) > 0 {
		n := min(len(raw), fragmentSize)
		part := make([]byte, n+1)
		copy(part[1:], raw[:n])
		raw = raw[n:]
		if len(raw) == 0 {
			part[0] = 1
		}
		if err = dc.Send(part); err != nil {
			return err
		}
	}
	emit(map[string]any{"id": p.id, "event": "buffer", "amount": dc.BufferedAmount()})
	return nil
}

// The bridge only negotiates with this renderer. Encoded RTP stays in Go;
// Chromium keeps its capture, decoder, jitter buffer and presentation clock.
func (p *peer) bridgeMedia(c command) error {
	socket, err := newLocalPacketConn()
	if err != nil {
		return err
	}
	mux := ice.NewUDPMuxDefault(ice.UDPMuxParams{UDPConn: socket})
	p.bridgeMux = mux
	settings := webrtc.SettingEngine{}
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetIPFilter(func(ip net.IP) bool { return ip.IsLoopback() || socket.addresses[ip.String()] })
	settings.SetICEUDPMux(mux)
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	media, videoCodec, audioCodec, err := mediaCodecs(c)
	if err != nil {
		return err
	}
	registry, _, err := bridgeInterceptors(media, 0)
	if err != nil {
		return err
	}
	api := webrtc.NewAPI(webrtc.WithSettingEngine(settings), webrtc.WithInterceptorRegistry(registry), webrtc.WithMediaEngine(media))
	local, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return err
	}
	p.bridge = local
	source, dest := local, p.pc
	if c.Receive {
		source, dest = p.pc, local
	}
	senders := map[webrtc.RTPCodecType]*webrtc.RTPSender{}
	outputs := map[webrtc.RTPCodecType]*webrtc.TrackLocalStaticRTP{}
	for _, kind := range []webrtc.RTPCodecType{webrtc.RTPCodecTypeVideo, webrtc.RTPCodecTypeAudio} {
		if (kind == webrtc.RTPCodecTypeAudio && !c.Audio) || (kind == webrtc.RTPCodecTypeVideo && !c.Video) {
			continue
		}
		var sender *webrtc.RTPSender
		if c.Receive {
			codec := audioCodec
			if kind == webrtc.RTPCodecTypeVideo {
				codec = videoCodec
			}
			track, e := webrtc.NewTrackLocalStaticRTP(codec, kind.String(), "roomcast")
			if e != nil {
				return e
			}
			outputs[kind] = track
			sender, err = local.AddTrack(track)
			if err != nil {
				return err
			}
		} else {
			track := p.video
			if kind == webrtc.RTPCodecTypeAudio {
				track = p.audio
			}
			outputs[kind] = track
			for _, s := range p.pc.GetSenders() {
				if s.Track() == track {
					sender = s
					break
				}
			}
			_, err = local.AddTransceiverFromKind(kind, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly})
			if err != nil {
				return err
			}
		}
		if sender != nil {
			senders[kind] = sender
			go p.bridgeFeedback(sender, source, kind)
		}
	}
	source.OnTrack(func(t *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		output := outputs[t.Kind()]
		if output == nil {
			return
		}
		sender := senders[t.Kind()]
		// An older publisher can choose H.264 from our VP8/H.264 receive offer.
		// Bind the local outgoing payload type to the codec actually received.
		if c.Receive && t.Kind() == webrtc.RTPCodecTypeVideo && t.Codec().MimeType != output.Codec().MimeType {
			next, err := webrtc.NewTrackLocalStaticRTP(t.Codec().RTPCodecCapability, output.ID(), output.StreamID())
			if err != nil || sender.ReplaceTrack(next) != nil {
				return
			}
			output = next
		}
		var firstPacket chan struct{}
		sourceTimeID := captureTimeID(receiver.GetParameters().HeaderExtensions)
		var destTimeID uint8
		if sender != nil {
			trackCtx, cancel := context.WithCancel(p.ctx)
			defer cancel()
			firstPacket = make(chan struct{})
			go forwardSenderClock(trackCtx, firstPacket, receiver, uint32(t.SSRC()), sender, dest, output.StreamID())
		}
		if t.Kind() == webrtc.RTPCodecTypeVideo {
			p.sourceVideo.Store(uint32(t.SSRC()))
			_ = source.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: uint32(t.SSRC())}})
		}
		for {
			packet, _, e := t.ReadRTP()
			if e != nil {
				return
			}
			// Only capture time belongs to the source clock. Transport feedback
			// and other hop-specific extensions are negotiated on the next leg.
			ready := firstPacket != nil && dest.ConnectionState() == webrtc.PeerConnectionStateConnected
			if ready {
				destTimeID = captureTimeID(sender.GetParameters().HeaderExtensions)
			}
			var captureTime []byte
			if sourceTimeID != 0 && destTimeID != 0 {
				captureTime = packet.GetExtension(sourceTimeID)
			}
			packet.Extension = false
			packet.Extensions = nil
			if len(captureTime) == 8 || len(captureTime) == 16 {
				packet.Extension = true
				packet.ExtensionProfile = rtp.ExtensionProfileOneByte
				if destTimeID > 14 {
					packet.ExtensionProfile = rtp.ExtensionProfileTwoByte
				}
				_ = packet.SetExtension(destTimeID, captureTime)
			}
			if e = output.WriteRTP(packet); e != nil {
				if p.closed.Load() {
					return
				}
				continue
			}
			if ready {
				close(firstPacket)
				firstPacket = nil
			}
			if c.Receive {
				p.received.Add(uint64(len(packet.Payload)))
			} else {
				p.sent.Add(uint64(len(packet.Payload)))
			}
		}
	})
	dest.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if dest == p.pc && !p.closed.Load() {
			emit(map[string]any{"id": p.id, "event": "state", "state": state.String()})
		}
		if state == webrtc.PeerConnectionStateConnected {
			if ssrc := p.sourceVideo.Load(); ssrc != 0 {
				_ = source.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: ssrc}})
			}
		}
	})
	raw, err := base64.StdEncoding.DecodeString(c.LocalOffer)
	if err != nil {
		return err
	}
	if err = local.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: string(raw)}); err != nil {
		return err
	}
	answer, err := local.CreateAnswer(nil)
	if err != nil {
		return err
	}
	gathered := webrtc.GatheringCompletePromise(local)
	if err = local.SetLocalDescription(answer); err != nil {
		return err
	}
	go func() {
		select {
		case <-p.ctx.Done():
			return
		case <-gathered:
		}
		desc := local.LocalDescription()
		if desc != nil && !p.closed.Load() {
			emit(map[string]any{"id": p.id, "event": "local-answer", "sdp": base64.StdEncoding.EncodeToString([]byte(desc.SDP))})
		}
	}()
	return nil
}

func (p *peer) bridgeFeedback(sender *webrtc.RTPSender, source *webrtc.PeerConnection, kind webrtc.RTPCodecType) {
	for {
		reports, _, err := sender.ReadRTCP()
		if err != nil {
			return
		}
		ssrc := p.sourceVideo.Load()
		if kind != webrtc.RTPCodecTypeVideo || ssrc == 0 {
			continue
		}
		for _, report := range reports {
			switch r := report.(type) {
			case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
				_ = source.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: ssrc}})
			case *rtcp.ReceiverEstimatedMaximumBitrate:
				// Only the network receiver can cap the publishing encoder. The
				// local playback bridge observes the already-paced incoming stream.
				if source == p.bridge {
					_ = source.WriteRTCP([]rtcp.Packet{&rtcp.ReceiverEstimatedMaximumBitrate{Bitrate: r.Bitrate, SSRCs: []uint32{ssrc}}})
				}
			case *rtcp.ReceiverReport:
				for _, block := range r.Reports {
					emit(map[string]any{"id": p.id, "event": "feedback", "fractionLost": block.FractionLost, "jitter": block.Jitter})
				}
			}
		}
	}
}
