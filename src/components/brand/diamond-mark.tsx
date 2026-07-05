/**
 * Diamond brand mark — inline SVG so it inherits theme tokens
 * and stays crisp at any size. Used in the site header and anywhere
 * the compact identity is needed.
 */
export function DiamondMark({
  size = 36,
  showSeam = true,
  className,
}: {
  size?: number;
  showSeam?: boolean;
  className?: string;
}) {
  const id = `dm-${Math.random().toString(36).slice(2, 8)}`;
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <radialGradient id={`${id}-bg`} cx="30%" cy="20%" r="90%">
          <stop offset="0%" stopColor="#22D3FF" stopOpacity="0.18" />
          <stop offset="60%" stopColor="#0C1220" stopOpacity="1" />
          <stop offset="100%" stopColor="#05080F" stopOpacity="1" />
        </radialGradient>
        <linearGradient id={`${id}-edge`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#7FEBFF" />
          <stop offset="100%" stopColor="#22D3FF" />
        </linearGradient>
        <filter id={`${id}-glow`} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="1.4" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Rounded midnight tile */}
      <rect x="1" y="1" width="62" height="62" rx="12" fill={`url(#${id}-bg)`} />
      <rect
        x="1"
        y="1"
        width="62"
        height="62"
        rx="12"
        fill="none"
        stroke="#1E2A44"
        strokeWidth="1"
      />

      {/* Neon rhombus */}
      <g filter={`url(#${id}-glow)`}>
        <polygon
          points="32,10 54,32 32,54 10,32"
          fill="rgba(34,211,255,0.06)"
          stroke={`url(#${id}-edge)`}
          strokeWidth="2"
          strokeLinejoin="round"
        />
      </g>

      {/* Emerald seam arc (optional) */}
      {showSeam ? (
        <path
          d="M17 38 Q 32 22 47 30"
          fill="none"
          stroke="#22E39B"
          strokeWidth="1.2"
          strokeLinecap="round"
          opacity="0.85"
        />
      ) : null}

      {/* Monogram D — right stem visually kisses the rhombus right edge */}
      <text
        x="32"
        y="43"
        textAnchor="middle"
        fontFamily='Inter, ui-sans-serif, system-ui, sans-serif'
        fontWeight={800}
        fontSize="26"
        fill="#EAF2FF"
        letterSpacing="-0.02em"
      >
        D
      </text>

      {/* Cut-gem facet highlight at top vertex */}
      <circle cx="32" cy="10" r="1.6" fill="#EAF2FF" opacity="0.95" />
    </svg>
  );
}
