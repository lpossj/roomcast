package main

import (
	"context"

	"github.com/pion/interceptor"
	"github.com/pion/interceptor/pkg/cc"
	"github.com/pion/interceptor/pkg/gcc"
	"github.com/pion/interceptor/pkg/report"
	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
)

const captureTimeURI = "http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time"

func captureTimeID(extensions []webrtc.RTPHeaderExtensionParameter) uint8 {
	for _, ext := range extensions {
		if ext.URI == captureTimeURI && ext.ID > 0 && ext.ID <= 255 {
			return uint8(ext.ID)
		}
	}
	return 0
}

// Forward the original RTP/NTP clock on each track. Generating a new sender
// report from arrival time at every hop would turn network jitter into A/V skew.
func bridgeInterceptors(media *webrtc.MediaEngine, sendBudget int) (*interceptor.Registry, func() int, error) {
	registry := &interceptor.Registry{}
	for _, kind := range []webrtc.RTPCodecType{webrtc.RTPCodecTypeAudio, webrtc.RTPCodecTypeVideo} {
		if err := media.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{URI: captureTimeURI}, kind); err != nil {
			return nil, nil, err
		}
	}
	var estimate cc.BandwidthEstimator
	if sendBudget > 0 {
		controller, err := cc.NewInterceptor(func() (cc.BandwidthEstimator, error) {
			return gcc.NewSendSideBWE(gcc.SendSideBWEInitialBitrate(sendBudget), gcc.SendSideBWEMaxBitrate(sendBudget))
		})
		if err != nil {
			return nil, nil, err
		}
		controller.OnNewPeerConnection(func(_ string, e cc.BandwidthEstimator) { estimate = e })
		registry.Add(controller)
		if err = webrtc.ConfigureTWCCHeaderExtensionSender(media, registry); err != nil {
			return nil, nil, err
		}
	}
	receiver, err := report.NewReceiverInterceptor()
	if err != nil {
		return nil, nil, err
	}
	registry.Add(receiver)
	if err = webrtc.ConfigureNack(media, registry); err != nil {
		return nil, nil, err
	}
	if err = webrtc.ConfigureTWCCSender(media, registry); err != nil {
		return nil, nil, err
	}
	if err = webrtc.ConfigureStatsInterceptor(registry); err != nil {
		return nil, nil, err
	}
	return registry, func() int {
		if estimate == nil {
			return 0
		}
		return estimate.GetTargetBitrate()
	}, nil
}

func forwardSenderClock(ctx context.Context, ready <-chan struct{}, receiver *webrtc.RTPReceiver, source uint32, sender *webrtc.RTPSender, dest *webrtc.PeerConnection, cname string) {
	for {
		reports, _, err := receiver.ReadRTCP()
		if err != nil {
			return
		}
		for _, msg := range reports {
			sr, ok := msg.(*rtcp.SenderReport)
			if !ok || sr.SSRC != source {
				continue
			}
			// Keep the original clock mapping until this track has sent RTP
			// on the connected outgoing leg, so the receiver knows its SSRC.
			select {
			case <-ctx.Done():
				return
			case <-ready:
			}
			encodings := sender.GetParameters().Encodings
			if len(encodings) == 0 {
				continue
			}
			translated := *sr
			translated.SSRC = uint32(encodings[0].SSRC)
			translated.Reports = nil
			// Both outgoing SSRCs use the same CNAME advertised in Pion's SDP.
			_ = dest.WriteRTCP([]rtcp.Packet{&translated, rtcp.NewCNAMESourceDescription(translated.SSRC, cname)})
		}
	}
}
