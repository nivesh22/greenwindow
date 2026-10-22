/** The assistant's mascot: a potted seedling. Inline SVG (about 1 KB), decorative; the blink is CSS (index.css,
 * .mascot-eye) and stops when the visitor prefers reduced motion. */
export function Mascot({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false" className={className}>
      <path d="M32 15c-1-6 3-10 9-12 2 6-2 11-9 12z" fill="#4fd08b" />
      <path d="M32 15c-1-5-5-8-10-8 0 5 4 8 10 8z" fill="#8ff0bd" />
      <circle cx="32" cy="29" r="15" fill="#3cbf7c" />
      <g className="mascot-eye">
        <circle cx="26" cy="29" r="3.9" fill="#1b1410" />
        <circle cx="27.4" cy="27.4" r="1.5" fill="#fff" />
        <circle cx="24.6" cy="30.4" r=".6" fill="#fff" />
      </g>
      <g className="mascot-eye">
        <circle cx="38" cy="29" r="3.9" fill="#1b1410" />
        <circle cx="39.4" cy="27.4" r="1.5" fill="#fff" />
        <circle cx="36.6" cy="30.4" r=".6" fill="#fff" />
      </g>
      <ellipse cx="20.5" cy="34" rx="2.8" ry="1.8" fill="#ff7f9a" opacity=".8" />
      <ellipse cx="43.5" cy="34" rx="2.8" ry="1.8" fill="#ff7f9a" opacity=".8" />
      <path d="M30 36c1.2 1.3 2.8 1.3 4 0" fill="none" stroke="#1b1410" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M15 44h34l-4 17H19z" fill="#c8794a" />
      <rect x="13" y="41" width="38" height="7" rx="3" fill="#dd8d5c" />
    </svg>
  )
}
