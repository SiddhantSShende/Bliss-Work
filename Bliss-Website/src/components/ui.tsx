import { forwardRef } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

/* ── Button ──────────────────────────────────────────────────────────────── */
/** Shared button styling, exported so routed links (react-router `<Link>`) can
 *  carry the same look on a single element instead of nesting a <button> in an <a>. */
export const button = cva(
  "relative inline-flex items-center justify-center gap-2 rounded-xl font-medium tracking-[-0.01em] transition-all duration-150 select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/55 focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:opacity-55 disabled:pointer-events-none active:scale-[0.98]",
  {
    variants: {
      variant: {
        primary:
          "bg-gradient-to-br from-brand-from to-brand-to text-accent-fg shadow-[0_6px_20px_-6px_var(--color-accent)] hover:shadow-[0_12px_28px_-6px_var(--color-accent)] hover:-translate-y-0.5 hover:brightness-105",
        secondary:
          "bg-surface text-fg border border-border hover:bg-surface-2 hover:border-muted/40",
        ghost: "text-fg hover:bg-surface-2",
        subtle: "bg-accent-soft text-accent hover:brightness-[0.97]",
        outline:
          "border border-accent/40 text-accent hover:bg-accent-soft hover:border-accent/60",
      },
      size: {
        sm: "h-8 px-3 text-[13px]",
        md: "h-10 px-4 text-sm",
        lg: "h-11 px-5 text-[15px]",
        xl: "h-12 px-6 text-[15px]",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, loading, disabled, children, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(button({ variant, size }), className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading && <Loader2 size={16} className="animate-spin" />}
      {children}
    </button>
  ),
);
Button.displayName = "Button";

/** Anchor styled exactly like a Button (for nav / download links). */
export function ButtonLink({
  className,
  variant,
  size,
  children,
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & VariantProps<typeof button>) {
  return (
    <a className={cn(button({ variant, size }), className)} {...props}>
      {children}
    </a>
  );
}

/* ── Surfaces ────────────────────────────────────────────────────────────── */
export const Card = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("rounded-2xl border border-border bg-surface shadow-soft", className)}
      {...props}
    />
  ),
);
Card.displayName = "Card";

/* ── Badge / Pill ────────────────────────────────────────────────────────── */
const tones = {
  neutral: "bg-surface-2 text-muted border-border",
  accent: "bg-accent-soft text-accent border-transparent",
  success: "bg-success/12 text-success border-transparent",
  danger: "bg-danger/12 text-danger border-transparent",
  warning: "bg-warning/15 text-warning border-transparent",
} as const;

export function Badge({
  className,
  tone = "neutral",
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: keyof typeof tones }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold tracking-wide",
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}

/** Eyebrow / section-kicker pill with a brand gradient dot. */
export function Eyebrow({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full border border-border bg-surface/70 px-3 py-1 text-xs font-semibold tracking-wide text-muted backdrop-blur",
        className,
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-gradient-to-br from-brand-from to-brand-to" />
      {children}
    </span>
  );
}

/* ── Avatar (brand-gradient initials) ────────────────────────────────────── */
const avatarSizes = {
  sm: "h-7 w-7 text-[10px]",
  md: "h-9 w-9 text-xs",
  lg: "h-11 w-11 text-sm",
  xl: "h-16 w-16 text-lg",
};

export function Avatar({
  name,
  size = "md",
  className,
}: {
  name: string;
  size?: keyof typeof avatarSizes;
  className?: string;
}) {
  const initials = name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-from to-brand-to font-semibold text-accent-fg shadow-[0_2px_10px_-2px_var(--color-accent)] ring-2 ring-surface",
        avatarSizes[size],
        className,
      )}
    >
      {initials || "?"}
    </div>
  );
}

/* ── Marketing layout helpers ────────────────────────────────────────────── */
export function Container({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <div className={cn("mx-auto w-full max-w-6xl px-5 sm:px-8", className)}>{children}</div>;
}

export function Section({
  className,
  children,
  id,
}: {
  className?: string;
  children: React.ReactNode;
  id?: string;
}) {
  return (
    <section id={id} className={cn("py-20 sm:py-28", className)}>
      {children}
    </section>
  );
}

/** Centered (or left) section heading: eyebrow + title + optional lead. */
export function SectionHeading({
  eyebrow,
  title,
  lead,
  align = "center",
  className,
}: {
  eyebrow?: string;
  title: React.ReactNode;
  lead?: React.ReactNode;
  align?: "center" | "left";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-4",
        align === "center" ? "items-center text-center" : "items-start text-left",
        className,
      )}
    >
      {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
      <h2 className="max-w-3xl text-balance text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
        {title}
      </h2>
      {lead && (
        <p className="max-w-2xl text-pretty text-base leading-relaxed text-muted sm:text-lg">
          {lead}
        </p>
      )}
    </div>
  );
}
