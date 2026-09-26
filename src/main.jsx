import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import './enhancements.css';
import './multi-share.css';
import { installIcePolicy } from './ice-policy.js';
import { unlockSounds } from './sounds.js';

installIcePolicy();
document.addEventListener('pointerdown', unlockSounds, { capture: true });
document.addEventListener('keydown', unlockSounds, { capture: true });

// Static hosts may not support a frame-ancestors response header. Never render
// room controls inside another site's frame.
if (window.top === window.self) {
  createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
} else {
  document.getElementById('root').textContent = '请直接打开网页观看链接。';
}
