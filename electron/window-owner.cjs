function liveWebContents(candidate) {
  try {
    if (!candidate || candidate.isDestroyed()) return null;
    const contents = candidate.webContents;
    return contents && !contents.isDestroyed() ? contents : null;
  } catch { return null; }
}

function ownsWindowEvent(event, candidate, trusted) {
  try {
    const contents = liveWebContents(candidate);
    return Boolean(contents && event?.sender === contents && event.senderFrame
      && event.senderFrame === contents.mainFrame && trusted(event.senderFrame.url));
  } catch { return false; }
}

module.exports = { liveWebContents, ownsWindowEvent };
