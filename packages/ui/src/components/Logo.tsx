import { useId } from "react";
import { cn } from "../lib/cn";

/** BlissWork mark: rounded gradient tile with a chat bubble + three dots. */
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
      <rect x="3" y="3" width="42" height="42" rx="13" fill={`url(#bw-${id})`} />
      {/* speech bubble */}
      <path
        d="M14.5 16.5h19a3.5 3.5 0 0 1 3.5 3.5v7a3.5 3.5 0 0 1-3.5 3.5H22l-6.2 4.6V31a3.5 3.5 0 0 1-1-2.5V20a3.5 3.5 0 0 1 3.5-3.5Z"
        fill="white"
      />
      <circle cx="20" cy="23.5" r="1.9" style={{ fill: "var(--color-brand-from)" }} />
      <circle cx="26" cy="23.5" r="1.9" style={{ fill: "var(--color-accent)" }} />
      <circle cx="32" cy="23.5" r="1.9" style={{ fill: "var(--color-brand-to)" }} />
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
