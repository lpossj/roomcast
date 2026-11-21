// Native Roomcast transport. The control interface is an inherited local pipe.
package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"

	"github.com/pion/webrtc/v4"
)

type command struct {
	Bitrate    int                     `json:"bitrate"`
	Control    bool                    `json:"control"`
	LocalOffer string                  `json:"localOffer"`
	Cmd        string                  `json:"cmd"`
	ID         string                  `json:"id"`
	Offer      string                  `json:"offer"`
	Answer     string                  `json:"answer"`
	Candidate  webrtc.ICECandidateInit `json:"candidate"`
	ICEServers []webrtc.ICEServer      `json:"iceServers"`
	Video      bool                    `json:"video"`
	Audio      bool                    `json:"audio"`
	Receive    bool                    `json:"receive"`
	EmitRTP    bool                    `json:"emitRtp"`
	Profile    string                  `json:"profileLevelId"`
	Data       string                  `json:"data"`
	PTS        int64                   `json:"ptsUs"`
	Keyframe   bool                    `json:"keyframe"`
}

type peer struct {
	budget                     func() int
	control                    *webrtc.DataChannel
	bridge                     *webrtc.PeerConnection
	bridgeMux                  *ice.UDPMuxDefault
	sourceVideo                atomic.Uint32
	id                         string
	pc                         *webrtc.PeerConnection
	mux                        *preparedSocket
	ctx                        context.Context
	cancel                     context.CancelFunc
	surveyCancel               context.CancelFunc
	mu                         sync.Mutex
	video, audio               *webrtc.TrackLocalStaticRTP
	videoPackets, audioPackets rtp.Packetizer
	needKeyframe               bool
	started                    time.Time
	closed                     atomic.Bool
	received, sent             atomic.Uint64
	ordinary, predicted        atomic.Uint64
	accepted, rejected         atomic.Uint64
	observations               atomic.Uint64
	restartUsed                bool
}

var outputMu sync.Mutex
var peers = map[string]*peer{}
var prepared = map[string]*preparedSocket{}
var idPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,95}$`)
var campusAdapter = regexp.MustCompile(`(?i)^Roomcast-[0-9a-f]{8}$`)
var profilePattern = regexp.MustCompile(`^[0-9a-fA-F]{6}$`)

func emit(value map[string]any) {
	outputMu.Lock()
	defer outputMu.Unlock()
	_ = json.NewEncoder(os.Stdout).Encode(value)
}
func failure(id, reason string) { emit(map[string]any{"event": "error", "id": id, "reason": reason}) }
func random32() uint32          { var b [4]byte; _, _ = rand.Read(b[:]); return binary.BigEndian.Uint32(b[:]) }
func (p *peer) close() {
	if p.closed.Swap(true) {
		return
	}
	p.cancel()
	p.mu.Lock()
	if p.surveyCancel != nil {
		p.surveyCancel()
	}
	p.mu.Unlock()
	if p.bridge != nil {
		_ = p.bridge.Close()
	}
	if p.bridgeMux != nil {
		_ = p.bridgeMux.Close()
	}
	_ = p.pc.Close()
	_ = p.mux.Close()
}

func mediaCodecs(c command) (*webrtc.MediaEngine, webrtc.RTPCodecCapability, webrtc.RTPCodecCapability, error) {
	media := &webrtc.MediaEngine{}
	videoCodec := webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90000,
		SDPFmtpLine:  "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=" + strings.ToLower(c.Profile),
		RTCPFeedback: []webrtc.RTCPFeedback{{Type: "nack"}, {Type: "nack", Parameter: "pli"}, {Type: "ccm", Parameter: "fir"}, {Type: "goog-remb"}}}
	audioCodec := webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2,
		SDPFmtpLine: "minptime=10;useinbandfec=1"}
	if c.Video {
		if err := media.RegisterCodec(webrtc.RTPCodecParameters{RTPCodecCapability: videoCodec, PayloadType: 102}, webrtc.RTPCodecTypeVideo); err != nil {
			return nil, videoCodec, audioCodec, err
		}
	}
	if c.Audio {
		if err := media.RegisterCodec(webrtc.RTPCodecParameters{RTPCodecCapability: audioCodec, PayloadType: 111}, webrtc.RTPCodecTypeAudio); err != nil {
			return nil, videoCodec, audioCodec, err
		}
	}
	return media, videoCodec, audioCodec, nil
}

func newPeer(c command) (*peer, error) {
	if !idPattern.MatchString(c.ID) || len(peers) >= 32 || peers[c.ID] != nil || (!c.Control && !c.Video && !c.Audio) {
		return nil, errors.New("invalid-session")
	}
	if c.Video && !profilePattern.MatchString(c.Profile) {
		return nil, errors.New("encoder-profile-required")
	}
	mux := prepared[c.ID]
	delete(prepared, c.ID)
	var err error
	if mux == nil {
		mux, err = prepareSystemSocket(c.ICEServers)
	}
	if err != nil {
		return nil, err
	}
	settings := webrtc.SettingEngine{}
	settings.SetNet(mux.network)
	settings.SetInterfaceFilter(func(name string) bool { return !campusAdapter.MatchString(name) })
	settings.SetICEUDPMux(mux)
	types := []webrtc.NetworkType{webrtc.NetworkTypeUDP4, webrtc.NetworkTypeUDP6}
	mux.enableTCP()
	if mux.tcp != nil {
		settings.SetICETCPMux(mux.tcp)
		types = append(types, webrtc.NetworkTypeTCP4, webrtc.NetworkTypeTCP6)
	}
	settings.SetNetworkTypes(types)
	media, videoCodec, audioCodec, err := mediaCodecs(c)
	if err != nil {
		_ = mux.Close()
		return nil, err
	}
	registry := &interceptor.Registry{}
	var budget func() int
	if c.LocalOffer != "" {
		var limit int
		if !c.Receive {
			limit = max(128000, min(c.Bitrate, 100000000))
		}
		registry, budget, err = bridgeInterceptors(media, limit)
	} else {
		err = webrtc.RegisterDefaultInterceptors(media, registry)
	}
	if err != nil {
		_ = mux.Close()
		return nil, err
	}
	api := webrtc.NewAPI(webrtc.WithMediaEngine(media), webrtc.WithInterceptorRegistry(registry), webrtc.WithSettingEngine(settings))
	// Do not ask stock gathering to open additional STUN sockets. Explicit survey
	// candidates below reference the media socket; ICE still validates each pair.
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		_ = mux.Close()
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	p := &peer{budget: budget, id: c.ID, pc: pc, mux: mux, ctx: ctx, cancel: cancel, needKeyframe: true, started: time.Now()}
	pc.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if candidate == nil || p.closed.Load() {
			return
		}
		p.ordinary.Add(1)
		emit(map[string]any{"event": "candidate", "id": p.id, "candidate": candidate.ToJSON(), "source": "ordinary"})
	})
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if !p.closed.Load() {
			emit(map[string]any{"event": "state", "id": p.id, "state": state.String()})
		}
	})
	pc.OnTrack(func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		emit(map[string]any{"event": "track", "id": p.id, "kind": track.Kind().String(), "codec": track.Codec().MimeType})
		if track.Kind() == webrtc.RTPCodecTypeVideo {
			_ = pc.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: uint32(track.SSRC())}})
		}
		for {
			packet, _, readErr := track.ReadRTP()
			if readErr != nil {
				return
			}
			p.received.Add(uint64(len(packet.Payload)))
			if c.EmitRTP {
				raw, marshalErr := packet.Marshal()
				if marshalErr != nil {
					continue
				}
				emit(map[string]any{"event": "rtp", "id": p.id, "kind": track.Kind().String(), "data": base64.StdEncoding.EncodeToString(raw)})
			}
		}
	})
	add := func(kind webrtc.RTPCodecType, codec webrtc.RTPCodecCapability) (*webrtc.TrackLocalStaticRTP, error) {
		if c.Receive {
			_, e := pc.AddTransceiverFromKind(kind, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly})
			return nil, e
		}
		track, e := webrtc.NewTrackLocalStaticRTP(codec, kind.String(), "roomcast")
		if e != nil {
			return nil, e
		}
		sender, e := pc.AddTrack(track)
		if e != nil {
			return nil, e
		}
		if c.LocalOffer == "" {
			go p.readFeedback(sender)
		}
		return track, nil
	}
	if c.Video {
		p.video, err = add(webrtc.RTPCodecTypeVideo, videoCodec)
		if err != nil {
			p.close()
			return nil, err
		}
		p.videoPackets = rtp.NewPacketizer(1200, 102, random32(), &codecs.H264Payloader{}, rtp.NewRandomSequencer(), 90000)
	}
	if c.Audio {
		p.audio, err = add(webrtc.RTPCodecTypeAudio, audioCodec)
		if err != nil {
			p.close()
			return nil, err
		}
		p.audioPackets = rtp.NewPacketizer(1200, 111, random32(), &codecs.OpusPayloader{}, rtp.NewRandomSequencer(), 48000)
	}
	if c.Control {
		if c.Offer == "" {
			dc, e := pc.CreateDataChannel("roomcast-v2", nil)
			if e != nil {
				p.close()
				return nil, e
			}
			p.bindControl(dc)
		} else {
			pc.OnDataChannel(p.bindControl)
		}
	}
	if c.LocalOffer != "" {
		if err = p.bridgeMedia(c); err != nil {
			p.close()
			return nil, err
		}
	}
	return p, nil
}

func (p *peer) readFeedback(sender *webrtc.RTPSender) {
	for {
		packets, _, err := sender.ReadRTCP()
		if err != nil {
			return
		}
		for _, packet := range packets {
			switch value := packet.(type) {
			case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
				p.mu.Lock()
				p.needKeyframe = true
				p.mu.Unlock()
				emit(map[string]any{"event": "feedback", "id": p.id, "keyframe": true})
			case *rtcp.ReceiverEstimatedMaximumBitrate:
				emit(map[string]any{"event": "feedback", "id": p.id, "bitrate": value.Bitrate})
			case *rtcp.ReceiverReport:
				for _, report := range value.Reports {
					emit(map[string]any{"event": "feedback", "id": p.id, "fractionLost": report.FractionLost, "jitter": report.Jitter})
				}
			}
		}
	}
}

func (p *peer) writeMedia(c command) error {
	if len(c.Data) > 6*1024*1024 || c.PTS < 0 {
		return errors.New("invalid-media")
	}
	bytes, err := base64.StdEncoding.DecodeString(c.Data)
	if err != nil {
		return errors.New("invalid-media")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed.Load() || p.pc.ConnectionState() != webrtc.PeerConnectionStateConnected {
		return nil
	}
	track, packetizer, rate := p.video, p.videoPackets, int64(90000)
	if c.Cmd == "audio" {
		track, packetizer, rate = p.audio, p.audioPackets, 48000
	} else if p.needKeyframe {
		if !c.Keyframe {
			return nil
		}
		p.needKeyframe = false
	}
	if track == nil || packetizer == nil {
		return errors.New("track-unavailable")
	}
	// Both streams use the same capture epoch; never reset audio/video independently.
	timestamp := uint32((c.PTS/1000000)*rate + (c.PTS%1000000)*rate/1000000)
	for _, packet := range packetizer.Packetize(bytes, 0) {
		packet.Timestamp = timestamp
		if err = track.WriteRTP(packet); err != nil {
			return errors.New("media-write-failed")
		}
		p.sent.Add(uint64(len(packet.Payload)))
	}
	return nil
}

type observation struct {
	address string
	port    int
	source  int
}

func (p *peer) survey() {
	p.mu.Lock()
	if p.surveyCancel != nil {
		p.surveyCancel()
	}
	ctx, cancel := context.WithTimeout(p.ctx, 5*time.Second)
	p.surveyCancel = cancel
	p.mu.Unlock()
	go func() {
		defer cancel()
		description := p.pc.LocalDescription()
		if description == nil {
			return
		}
		mid, fragment := "", ""
		for _, line := range strings.Split(description.SDP, "\r\n") {
			if mid == "" && strings.HasPrefix(line, "a=mid:") {
				mid = strings.TrimPrefix(line, "a=mid:")
			}
			if fragment == "" && strings.HasPrefix(line, "a=ice-ufrag:") {
				fragment = strings.TrimPrefix(line, "a=ice-ufrag:")
			}
		}
		if mid == "" || fragment == "" {
			return
		}
		observations := []observation{}
		for item := range p.mux.observations {
			if p.closed.Load() || ctx.Err() != nil {
				return
			}
			observations = append(observations, item)
			p.observations.Add(1)
			p.emitMapped(item, mid, fragment, fmt.Sprintf("rcns%d", item.source), "observed")
		}
		if len(observations) != 3 || ctx.Err() != nil {
			return
		}
		sort.Slice(observations, func(i, j int) bool { return observations[i].port < observations[j].port })
		low, high := observations[0], observations[2]
		step := observations[1].port - low.port
		if step <= 0 || high.port-observations[1].port != step || low.address != high.address || low.address != observations[1].address {
			return
		}
		for _, direction := range []int{1, -1} {
			anchor := high
			sign := "p"
			if direction < 0 {
				anchor = low
				sign = "m"
			}
			for offset := 1; offset <= 4; offset++ {
				port := anchor.port + direction*step*offset
				if port < 1 || port > 65535 || ctx.Err() != nil || p.closed.Load() {
					continue
				}
				p.emitMapped(observation{address: anchor.address, port: port}, mid, fragment, fmt.Sprintf("rcnp%s%d", sign, offset), "predicted")
				p.predicted.Add(1)
			}
		}
	}()
}

func (p *peer) emitMapped(value observation, mid, fragment, foundation, source string) {
	index := uint16(0)
	base := p.mux.LocalAddr().(*net.UDPAddr)
	candidate := webrtc.ICECandidateInit{Candidate: fmt.Sprintf("candidate:%s 1 udp 1694498815 %s %d typ srflx raddr 0.0.0.0 rport %d ufrag %s", foundation, value.address, value.port, base.Port, fragment), SDPMid: &mid, SDPMLineIndex: &index, UsernameFragment: &fragment}
	emit(map[string]any{"event": "candidate", "id": p.id, "candidate": candidate, "source": source})
}

func (p *peer) stats() {
	value := map[string]any{"event": "stats", "id": p.id, "state": p.pc.ConnectionState().String(), "elapsedMs": time.Since(p.started).Milliseconds(),
		"ordinary": p.ordinary.Load(), "predicted": p.predicted.Load(), "observations": p.observations.Load(),
		"accepted": p.accepted.Load(), "rejected": p.rejected.Load(), "mediaBytesSent": p.sent.Load(), "mediaBytesReceived": p.received.Load()}
	if p.budget != nil {
		value["availableBitrate"] = p.budget()
	}
	// Poll the active path directly. A full report enumerates all ICE pairs,
	// RTP streams and certificates for every viewer on the helper command loop.
	if sctp := p.pc.SCTP(); sctp != nil && sctp.Transport() != nil {
		transport := sctp.Transport().ICETransport()
		if pair, err := transport.GetSelectedCandidatePair(); err == nil && pair != nil {
			value["protocol"] = pair.Local.Protocol.String()
			value["localType"] = pair.Local.Typ.String()
			value["remoteType"] = pair.Remote.Typ.String()
			value["relay"] = pair.Local.Typ == webrtc.ICECandidateTypeRelay || pair.Remote.Typ == webrtc.ICECandidateTypeRelay
		}
		if stats, ok := transport.GetSelectedCandidatePairStats(); ok {
			value["rttMs"] = stats.CurrentRoundTripTime * 1000
			value["bytesSent"] = stats.BytesSent
			value["bytesReceived"] = stats.BytesReceived
		}
	}
	value["sameSocket"] = value["protocol"] == "udp"
	emit(value)
}

func handle(c command) error {
	if (c.Cmd == "video" || c.Cmd == "audio") && c.ID == "" {
		for _, p := range peers {
			if err := p.writeMedia(c); err != nil {
				failure(p.id, err.Error())
			}
		}
		return nil
	}
	if c.Cmd == "prepare" {
		if !idPattern.MatchString(c.ID) || prepared[c.ID] != nil || peers[c.ID] != nil || len(prepared)+len(peers) >= 32 {
			return errors.New("invalid-session")
		}
		mux, e := prepareSystemSocket(c.ICEServers)
		if e != nil {
			return e
		}
		prepared[c.ID] = mux
		emit(map[string]any{"id": c.ID, "event": "prepared"})
		return nil
	}
	if c.Cmd == "create" {
		p, err := newPeer(c)
		if err != nil {
			return err
		}
		peers[c.ID] = p
		var description webrtc.SessionDescription
		if c.Offer != "" {
			raw, e := base64.StdEncoding.DecodeString(c.Offer)
			if e != nil {
				p.close()
				delete(peers, c.ID)
				return errors.New("invalid-offer")
			}
			err = p.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: string(raw)})
			if err == nil {
				description, err = p.pc.CreateAnswer(nil)
			}
		} else {
			description, err = p.pc.CreateOffer(nil)
		}
		if err == nil {
			err = p.pc.SetLocalDescription(description)
		}
		if err != nil {
			p.close()
			delete(peers, c.ID)
			return errors.New("negotiation-failed")
		}
		emit(map[string]any{"event": description.Type.String(), "id": c.ID, "sdp": base64.StdEncoding.EncodeToString([]byte(p.pc.LocalDescription().SDP))})
		p.survey()
		return nil
	}
	p := peers[c.ID]
	if p == nil {
		if c.Cmd == "close" {
			if mux := prepared[c.ID]; mux != nil {
				_ = mux.Close()
				delete(prepared, c.ID)
			}
			return nil
		}
		return errors.New("session-unavailable")
	}
	switch c.Cmd {
	case "close":
		p.close()
		delete(peers, c.ID)
		emit(map[string]any{"event": "closed", "id": c.ID})
	case "answer":
		raw, err := base64.StdEncoding.DecodeString(c.Answer)
		if err != nil {
			return errors.New("invalid-answer")
		}
		if p.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: string(raw)}) != nil {
			return errors.New("answer-rejected")
		}
	case "local-candidate":
		if p.bridge == nil {
			return errors.New("bridge-unavailable")
		}
		if err := p.bridge.AddICECandidate(c.Candidate); err != nil {
			return errors.New("local-candidate-rejected")
		}
	case "candidate":
		if c.Candidate.UsernameFragment != nil && c.Candidate.Candidate != "" && !strings.Contains(c.Candidate.Candidate, " ufrag ") {
			fragment := *c.Candidate.UsernameFragment
			if strings.ContainsAny(fragment, " \r\n\t") {
				return errors.New("invalid-generation")
			}
			c.Candidate.Candidate += " ufrag " + fragment
		}
		if p.pc.AddICECandidate(c.Candidate) != nil {
			p.rejected.Add(1)
			emit(map[string]any{"event": "candidate-result", "id": c.ID, "accepted": false})
			return nil
		}
		p.accepted.Add(1)
	case "send":
		return p.sendControl(c.Data)
	case "video", "audio":
		return p.writeMedia(c)
	case "stats":
		p.stats()
	default:
		return errors.New("unsupported-command")
	}
	return nil
}

func main() {
	defer func() {
		for _, p := range peers {
			p.close()
		}
	}()
	emit(map[string]any{"event": "ready", "protocol": 1, "nativeUdpMux": true, "control": true, "mediaBridge": true})
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64*1024), 12*1024*1024)
	for scanner.Scan() {
		var c command
		if json.Unmarshal(scanner.Bytes(), &c) != nil {
			failure("", "invalid-command")
			continue
		}
		if err := handle(c); err != nil {
			failure(c.ID, err.Error())
		}
	}
}
