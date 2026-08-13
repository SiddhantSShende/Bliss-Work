import { useId } from "react";
import { cn } from "../lib/cn";

/** BlissWork mark: a "B" monogram with a chat bubble + three dots in the lower lobe. */
export function Logo({ size = 32, className }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      className={cn("shrink-0", className)}
      aria-label="BlissWork"
    >
      <defs>
        <linearGradient id={`bw-${id}`} x1="6" y1="4" x2="42" y2="44" gradientUnits="userSpaceOnUse">
          <stop offset="0" style={{ stopColor: "var(--color-brand-from)" }} />
          <stop offset="1" style={{ stopColor: "var(--color-brand-to)" }} />
        </linearGradient>
      </defs>
      <rect x="9" y="6" width="10.5" height="36" rx="5.25" fill={`url(#bw-${id})`} />
      <path
        d="M9,6 L30,6 Q39.4,6 39.4,15.94 Q39.4,22.5 33.75,24 Q39.4,25.5 39.4,32.06 Q39.4,42 31.88,42 L9,42 Z"
        fill={`url(#bw-${id})`}
      />
      {/* speech bubble */}
      <rect x="12.94" y="27.38" width="26.06" height="10.31" rx="2.53" fill="white" />
      <path d="M15.94,37.69 L11.63,37.69 L9.38,42.19 Q9.09,42.84 9.84,42.38 Z" fill="white" />
      <circle cx="20.53" cy="32.53" r="1.5" style={{ fill: "var(--color-brand-from)" }} />
      <circle cx="25.97" cy="32.53" r="1.5" style={{ fill: "var(--color-accent)" }} />
      <circle cx="31.41" cy="32.53" r="1.5" style={{ fill: "var(--color-brand-to)" }} />
    </svg>
  );
}

/** Logo + wordmark lockup. */
export function Wordmark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <Logo size={size} />
      <span className="text-[17px] font-semibold tracking-tight text-fg">
        Bliss<span className="text-accent">Work</span>
      </span>
    </span>
  );
}
