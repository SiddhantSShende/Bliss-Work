import { forwardRef } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "../lib/cn";

const button = cva(
  "relative inline-flex items-center justify-center gap-2 rounded-xl font-medium tracking-[-0.01em] transition-all duration-150 select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/55 focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:opacity-55 disabled:pointer-events-none active:scale-[0.98]",
  {
    variants: {
      variant: {
        primary:
          "bg-gradient-to-br from-brand-from via-brand-mid to-brand-to text-accent-fg shadow-[0_6px_20px_-6px_var(--color-accent)] hover:shadow-[0_12px_28px_-6px_var(--color-accent)] hover:-translate-y-0.5 hover:brightness-105",
        secondary:
          "bg-surface text-fg border border-border hover:bg-surface-2 hover:border-muted/40",
        ghost: "text-fg hover:bg-surface-2",
        subtle: "bg-gradient-to-br from-brand-from/15 to-brand-to/15 text-accent hover:brightness-[0.97]",
        danger: "bg-danger text-white shadow-soft hover:brightness-110",
        success: "bg-success text-white shadow-soft hover:brightness-110",
      },
      size: {
        sm: "h-8 px-3 text-[13px]",
        md: "h-10 px-4 text-sm",
        lg: "h-11 px-5 text-[15px]",
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
