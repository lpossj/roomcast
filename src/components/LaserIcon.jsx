export default function LaserIcon({ size = 16, className = '' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="17.5" cy="6.5" r="2.5" fill="currentColor" stroke="none" />
      <path d="M17.5 2v1.6M22 6.5h-1.6M20.7 3.3l-1.1 1.1" />
      <path d="M14.2 9.8L11.5 12.5" strokeDasharray="1.8 2.4" />
      <path d="M3 18.8L8.4 13.4a1.4 1.4 0 0 1 2 0l.2.2a1.4 1.4 0 0 1 0 2L5.2 21A1.55 1.55 0 0 1 3 18.8Z" />
    </svg>
  );
}
