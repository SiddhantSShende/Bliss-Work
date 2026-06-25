import { forwardRef } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "../lib/cn";

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

/** Frosted-glass surface (uses the .glass utility from the app stylesheet). */
export const GlassCard = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("glass rounded-2xl", className)} {...props} />
  ),
);
GlassCard.displayName = "GlassCard";

const field =
  "w-full rounded-xl border border-border bg-surface px-3.5 text-sm text-fg placeholder:text-muted/70 transition-colors focus-visible:outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25";

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input ref={ref} className={cn(field, "h-11", className)} {...props} />
  ),
);
Input.displayName = "Input";

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn(field, "min-h-24 py-2.5 leading-relaxed", className)} {...props} />
));
Textarea.displayName = "Textarea";

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

const avatarSizes = { sm: "h-7 w-7 text-[10px]", md: "h-9 w-9 text-xs", lg: "h-11 w-11 text-sm" };

const dotSizes = { sm: "h-2 w-2", md: "h-2.5 w-2.5", lg: "h-3 w-3" };

export function Avatar({
  name,
  size = "md",
  online,
  className,
}: {
  name: string;
  size?: keyof typeof avatarSizes;
  /** undefined = no indicator; true = green dot; false = muted dot. */
  online?: boolean;
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
    <div className={cn("relative shrink-0", className)}>
      <div
        className={cn(
          "flex items-center justify-center rounded-full bg-gradient-to-br from-brand-from to-brand-to font-semibold text-accent-fg shadow-[0_2px_10px_-2px_var(--color-accent)] ring-2 ring-surface",
          avatarSizes[size],
        )}
      >
        {initials || "?"}
      </div>
      {online !== undefined && (
        <span
          className={cn(
            "absolute -bottom-0 -right-0 rounded-full ring-2 ring-surface",
            dotSizes[size],
            online ? "bg-success" : "bg-muted/50",
          )}
        />
      )}
    </div>
  );
}

export const IconButton = forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }
>(({ className, active, ...props }, ref) => (
  <button
    ref={ref}
    className={cn(
      "relative inline-flex h-9 w-9 items-center justify-center rounded-xl text-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
      active && "bg-accent-soft text-accent",
      className,
    )}
    {...props}
  />
));
IconButton.displayName = "IconButton";

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("animate-spin text-muted", className)} size={18} />;
}

/** Consistent page-level header for main-pane routes (title + optional action). */
export function PageHeader({
  title,
  subtitle,
  action,
  className,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 border-b border-border/60 px-6 py-4",
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="truncate text-lg font-semibold tracking-tight text-fg">{title}</h1>
        {subtitle && <p className="mt-0.5 truncate text-sm text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  hint,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  hint?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-6 py-16 text-center",
        className,
      )}
    >
      {icon && (
        <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-from to-brand-to text-accent-fg shadow-[0_10px_30px_-8px_var(--color-accent)]">
          <div className="absolute inset-0 -z-10 rounded-2xl bg-accent/30 blur-xl" />
          {icon}
        </div>
      )}
      <div className="space-y-1">
        <p className="text-base font-semibold tracking-tight text-fg">{title}</p>
        {hint && <p className="max-w-xs text-sm text-muted">{hint}</p>}
      </div>
    </div>
  );
}
