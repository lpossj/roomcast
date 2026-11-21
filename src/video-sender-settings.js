import { p2pResolutionScale } from './video-quality-tiers.js';

// Chromium reads the encoder's initial estimate from its remote video codec,
// which is the loopback answer on a physical-direct desktop.
export function withScreenStartBitrate(sdp, bitrateKbps) {
  if (!(bitrateKbps > 0)) return sdp;
  return sdp.split(/(?=^m=)/m).map(section => {
    if (!/^m=video [1-9]\d* /m.test(section) || /^a=(?:sendonly|inactive)\r?$/m.test(section)) return section;
    const lines = section.trimEnd().split(/\r?\n/);
    const limits = [bitrateKbps];
    for (const line of lines) {
      const limit = /^b=(AS|TIAS):(\d+)$/.exec(line);
      if (limit) limits.push(Number(limit[2]) / (limit[1] === 'TIAS' ? 1000 : 1));
    }
    for (const match of section.matchAll(/^a=rtpmap:(\d+) (?:H264|VP[89]|AV1)\//gmi)) {
      const prefix = `a=fmtp:${match[1]} `;
      const index = lines.findIndex(line => line.startsWith(prefix));
      const params = index >= 0 ? lines[index].slice(prefix.length).split(';') : [];
      const hints = params.flatMap(param => {
        const value = /^\s*x-google-(?:start|max)-bitrate=(\d+)\s*$/i.exec(param);
        return value ? [Number(value[1])] : [];
      });
      const start = Math.floor(Math.min(...limits, ...hints));
      if (start <= 0) continue;
      const fmtp = [...params.filter(p => !/^\s*x-google-start-bitrate=/i.test(p)), `x-google-start-bitrate=${start}`];
      if (index < 0) lines.push(prefix + fmtp.join(';'));
      else lines[index] = prefix + fmtp.join(';');
    }
    return lines.join('\r\n') + '\r\n';
  }).join('');
}

export async function configureScreenVideoSender(sender, quality, route) {
  const parameters = sender.getParameters();
  if (!parameters.encodings?.length) parameters.encodings = [{}];
  const encoding = parameters.encodings[0];
  delete encoding.scaleResolutionDownTo;
  encoding.scaleResolutionDownBy = ['p2p', 'campus', 'native'].includes(route) ? p2pResolutionScale(sender.track, quality) : 1;
  if (quality.bitrate > 0) encoding.maxBitrate = quality.bitrate * 1000;
  else delete encoding.maxBitrate;
  encoding.maxFramerate = quality.fps;
  encoding.priority = 'high'; encoding.networkPriority = 'high'; encoding.bitratePriority = 2;
  parameters.degradationPreference = quality.performanceMode === 'smooth' ? 'maintain-framerate' : 'maintain-resolution';
  try {
    await sender.setParameters(parameters);
    return true;
  } catch {
    return false;
  }
}
