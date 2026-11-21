export default function StaticStudioBackdrop() {
  return (
    <div className="static-studio-backdrop" aria-hidden="true">
      <svg
        className="static-studio-svg"
        viewBox="0 0 1200 720"
        preserveAspectRatio="xMidYMid slice"
        fill="none"
      >
        <defs>
          <radialGradient id="roomcast-halo-a" cx="68%" cy="46%" r="48%">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.18" />
            <stop offset="65%" stopColor="var(--accent)" stopOpacity="0.04" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="roomcast-halo-b" cx="28%" cy="62%" r="42%">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.1" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width="1200" height="720" fill="url(#roomcast-halo-a)" />
        <rect width="1200" height="720" fill="url(#roomcast-halo-b)" />
        <g stroke="var(--accent)" strokeOpacity="0.14" strokeWidth="1.2">
          <ellipse cx="780" cy="350" rx="280" ry="118" transform="rotate(-18 780 350)" />
          <ellipse cx="780" cy="350" rx="220" ry="92" transform="rotate(22 780 350)" />
          <circle cx="780" cy="350" r="148" strokeOpacity="0.09" strokeDasharray="4 8" />
        </g>
      </svg>
    </div>
  );
}
