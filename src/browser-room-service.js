import { attachRooms } from '../server/rooms.mjs';

export function createBrowserRoomService() {
  let onConnection;
  const active = new Set();
  const io = {
    on(name, listener) { if (name === 'connection') onConnection = listener; },
    off(name, listener) { if (name === 'connection' && onConnection === listener) onConnection = null; },
  };
  const rooms = attachRooms(io);

  function connect() {
    const serverHandlers = new Map();
    const clientHandlers = new Map();
    const add = (handlers, name, listener) => {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(listener);
    };
    const notify = (handlers, name, ...args) => {
      for (const listener of handlers.get(name) || []) listener(...args);
    };
    const disconnect = () => {
      if (!serverSocket.connected) return;
      serverSocket.connected = false;
      client.connected = false;
      active.delete(client);
      notify(serverHandlers, 'disconnect', 'io client disconnect');
      notify(clientHandlers, 'disconnect', 'io client disconnect');
    };
    const serverSocket = {
      id: crypto.randomUUID(), connected: true, data: {}, handshake: { address: 'browser-local' },
      on(name, listener) { add(serverHandlers, name, listener); },
      emit(name, payload) { notify(clientHandlers, name, payload); },
      disconnect,
    };
    const client = {
      connected: true,
      on(name, listener) { add(clientHandlers, name, listener); return this; },
      removeAllListeners() { clientHandlers.clear(); return this; },
      disconnect,
      timeout(milliseconds) {
        return { emit(name, payload, callback) {
          const listener = serverHandlers.get(name)?.values().next().value;
          if (!listener) { callback(new Error('Unknown room operation')); return; }
          let done = false;
          const timer = setTimeout(() => { if (!done) { done = true; callback(new Error('Room operation timed out')); } }, milliseconds);
          listener(payload, result => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            callback(null, result);
          });
        } };
      },
    };
    active.add(client);
    onConnection(serverSocket);
    return client;
  }

  return { connect, close: async () => { for (const socket of active) socket.disconnect(); await rooms.close(); } };
}
