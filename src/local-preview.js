export function selectScreenPlayback({ viewerMemberId, publisherMemberId, localStream }) {
  const isSelf = Boolean(viewerMemberId && publisherMemberId && viewerMemberId === publisherMemberId);
  if (!isSelf) return { isSelf: false, mode: 'remote' };
  if (localStream?.active) return { isSelf: true, mode: 'local-stream' };
  return { isSelf: true, mode: 'unavailable' };
}
