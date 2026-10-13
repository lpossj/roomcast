import { p2pResolutionScale } from './p2p-video-policy.js';

export async function configureScreenVideoSender(sender, quality, route) {
  const parameters = sender.getParameters();
  if (!parameters.encodings?.length) parameters.encodings = [{}];
  const encoding = parameters.encodings[0];
  delete encoding.scaleResolutionDownTo;
  encoding.scaleResolutionDownBy = route === 'p2p' || route === 'campus' ? p2pResolutionScale(sender.track, quality) : 1;
  if (quality.bitrate > 0) encoding.maxBitrate = quality.bitrate * 1000;
  else delete encoding.maxBitrate;
  encoding.maxFramerate = quality.fps;
  encoding.priority = 'high'; encoding.networkPriority = 'high'; encoding.bitratePriority = 2;
  parameters.degradationPreference = quality.performanceMode === 'smooth' ? 'maintain-framerate' : 'maintain-resolution';
  await sender.setParameters(parameters).catch(() => {});
}
