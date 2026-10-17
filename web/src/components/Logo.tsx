/** The GreenWindow mark: an intensity curve with its low window underlined (same drawing as public/favicon.svg). */
export function LogoMark({ className = 'h-7 w-7' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#0d7a4e" />
      <path d="M5 10.5c5 0 6 11 11 11s6-11 11-11" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" />
      <rect x="11.5" y="24.5" width="9" height="2.6" rx="1.3" fill="#8ff0bd" />
    </svg>
  )
}
