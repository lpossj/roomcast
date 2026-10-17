import { createLaserCanvas } from './laser-canvas.mjs';
let members = new Map();
const canvas = document.querySelector('canvas');
const engine = createLaserCanvas(canvas, {
  getBounds: () => ({ left: 0, top: 0, width: innerWidth, height: innerHeight }),
  getMember: id => members.get(id),
  onIdle: () => window.desktopLaserSurface.idle(),
});
const unsubscribe = window.desktopLaserSurface.receive(value => {
  members = new Map(value.members.map(member => [member.id, member]));
  engine.receive(value.packet);
});
window.addEventListener('unload', () => { unsubscribe(); engine.destroy(); }, { once: true });
