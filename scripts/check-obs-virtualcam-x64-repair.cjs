// Step5 x64-only registration was retired after auditing OBS 32.1.2.
// OBS's win-dshow virtual-camera output requires the 32-bit registration view
// as well, so the final dual-view regression test is authoritative.
require('./check-obs-virtualcam-final.cjs');
