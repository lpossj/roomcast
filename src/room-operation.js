// Stop awaiting an operation even when the underlying transport never settles.
// Its eventual result is consumed, but cannot update a cancelled room session.
export function waitForRoomOperation(task, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    const settle = (callback, value) => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(signal.reason);
      else callback(value);
    };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(task).then(value => settle(resolve, value), error => settle(reject, error));
    if (signal.aborted) abort();
  });
}
