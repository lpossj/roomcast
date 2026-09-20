const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  ObsWebSocketClient,
  waitForObsVirtualCameraAvailable,
} = require('../electron/obs-fixed-fps.cjs');

const root = path.resolve(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'src', 'App.jsx'), 'utf8');

function eventWith(type, values = {}) {
  const event = new Event(type);
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(event, key, { value, enumerable: true });
  }
  return event;
}

class FakeWebSocket extends EventTarget {
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    super();
    this.url = url;
    this.readyState = FakeWebSocket.OPEN;
    this.index = FakeWebSocket.instances.length;
    FakeWebSocket.instances.push(this);
    setTimeout(() => {
      if (this.readyState === FakeWebSocket.OPEN) {
        this.dispatchEvent(eventWith('message', { data: JSON.stringify({ op: 0, d: {} }) }));
      }
    }, 0);
  }

  send(raw) {
    const packet = JSON.parse(String(raw));
    if (packet.op === 1) {
      setTimeout(() => {
        if (this.readyState === FakeWebSocket.OPEN) {
          this.dispatchEvent(eventWith('message', { data: JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }) }));
        }
      }, 0);
      return;
    }
    if (packet.op === 6) {
      const delay = this.index === 1 ? 130 : 5;
      setTimeout(() => {
        if (this.readyState === FakeWebSocket.OPEN) {
          this.dispatchEvent(eventWith('message', {
            data: JSON.stringify({
              op: 7,
              d: {
                requestId: packet.d.requestId,
                requestStatus: { result: true, code: 100 },
                responseData: { socketIndex: this.index },
              },
            }),
          }));
        }
      }, delay);
    }
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    // The first OBS connection deliberately closes late, after the second
    // connection is already identified. This reproduces the clean-PC
    // register -> restart race that the old client mishandled.
    const delay = this.index === 0 ? 70 : 0;
    setTimeout(() => this.dispatchEvent(eventWith('close', { code: 1000 })), delay);
  }
}

async function checkStaleCloseIsolation() {
  FakeWebSocket.instances.length = 0;
  const client = new ObsWebSocketClient({ WebSocketImpl: FakeWebSocket });
  await client.connect('ws://first', '');
  assert.equal(client.ready, true);
  const first = FakeWebSocket.instances[0];

  await client.close();
  await client.connect('ws://second', '');
  const second = FakeWebSocket.instances[1];
  assert.notEqual(first, second);
  assert.equal(client.ready, true);

  const pending = client.request('GetVersion');
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.equal(client.socket, second, 'late close from old socket must not detach the new socket');
  assert.equal(client.ready, true, 'late close from old socket must not mark the new connection not-ready');
  const response = await pending;
  assert.equal(response.socketIndex, 1, 'pending request must survive the old socket close event');
  await client.close();
}

async function checkDelayedVirtualCamReadiness() {
  let attempts = 0;
  const engine = {
    async virtualCameraCapability() {
      attempts += 1;
      if (attempts < 4) return { available: false, active: false };
      return { available: true, active: false };
    },
  };
  const result = await waitForObsVirtualCameraAvailable(engine, {
    timeoutMs: 1000,
    pollMs: 1,
    delayFn: () => Promise.resolve(),
  });
  assert.equal(result.available, true);
  assert.equal(result.attempts, 4);
}

function checkNoSilentNativeFallback() {
  assert.match(mainSource, /fallbackNative:\s*false[\s\S]{0,240}phase:\s*'sources'/, 'source enumeration failure must stay on OBS');
  assert.match(mainSource, /fallbackNative:\s*false[\s\S]{0,240}phase:\s*startPhase/, 'OBS start failure must stay on OBS');
  assert.match(mainSource, /waitForObsVirtualCameraAvailable\(engine/, 'main process must wait for delayed Virtual Camera readiness');
  assert.doesNotMatch(appSource, /OBS 启动失败，已切换到原生采集/, 'renderer must not silently switch OBS start failures to native');
  assert.doesNotMatch(appSource, /OBS 暂不可用，已自动切换到原生采集/, 'renderer must not silently switch OBS source failures to native');
}

(async () => {
  await checkStaleCloseIsolation();
  await checkDelayedVirtualCamReadiness();
  checkNoSilentNativeFallback();
  console.log('[Clean-PC OBS rewrite] stale websocket close isolation: PASS');
  console.log('[Clean-PC OBS rewrite] delayed Virtual Camera readiness: PASS');
  console.log('[Clean-PC OBS rewrite] no silent native fallback: PASS');
  console.log('[Clean-PC OBS rewrite] PASS');
})().catch(error => {
  console.error('[Clean-PC OBS rewrite] FAIL');
  console.error(error?.stack || error);
  process.exitCode = 1;
});
