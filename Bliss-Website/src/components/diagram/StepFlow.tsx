import { Fragment, type ComponentType } from "react";
import { motion } from "framer-motion";
import { ChevronDown, ChevronRight, type LucideProps } from "lucide-react";
import { Card } from "@/components/ui";
import { cn } from "@/lib/cn";

export interface FlowStep {
  title: string;
  desc: string;
  icon: ComponentType<LucideProps>;
  /** Optional tone for the step (defaults to brand gradient). */
  tone?: "brand" | "success" | "danger";
}

const toneRing: Record<NonNullable<FlowStep["tone"]>, string> = {
  brand: "from-brand-from to-brand-to text-accent-fg",
  success: "from-success to-success text-white",
  danger: "from-danger to-danger text-white",
};

/** A horizontal (desktop) / vertical (mobile) animated journey of numbered steps. */
export function StepFlow({ steps, className }: { steps: FlowStep[]; className?: string }) {
  return (
    <div
      className={cn(
        "flex flex-col items-stretch gap-3 lg:flex-row lg:items-center",
        className,
      )}
    >
      {steps.map((step, i) => (
        <Fragment key={step.title}>
          <motion.div
            className="lg:flex-1"
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.4 }}
            transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1], delay: i * 0.12 }}
          >
            <StepCard step={step} index={i} />
          </motion.div>
          {i < steps.length - 1 && <Connector index={i} />}
        </Fragment>
      ))}
    </div>
  );
}

function StepCard({ step, index }: { step: FlowStep; index: number }) {
  const Icon = step.icon;
  const tone = step.tone ?? "brand";
  return (
    <Card className="ring-glow relative h-full overflow-hidden p-5">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br font-semibold shadow-[0_6px_18px_-8px_var(--color-accent)]",
            toneRing[tone],
          )}
        >
          <Icon size={18} />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-bold tracking-wider text-muted">
              STEP {index + 1}
            </span>
          </div>
          <h4 className="mt-0.5 text-base font-semibold tracking-tight text-fg">{step.title}</h4>
        </div>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-muted">{step.desc}</p>
    </Card>
  );
}

function Connector({ index }: { index: number }) {
  return (
    <motion.div
      className="flex shrink-0 items-center justify-center self-center text-muted/50 lg:px-0.5"
      initial={{ opacity: 0, scale: 0.6 }}
      whileInView={{ opacity: 1, scale: 1 }}
      viewport={{ once: true, amount: 0.6 }}
      transition={{ duration: 0.4, delay: 0.18 + index * 0.12 }}
    >
      <span className="hidden h-8 w-8 items-center justify-center rounded-full border border-border bg-surface lg:flex">
        <ChevronRight size={16} className="text-accent" />
      </span>
      <span className="flex h-8 w-8 items-center justify-center rounded-full border border-border bg-surface lg:hidden">
        <ChevronDown size={16} className="text-accent" />
      </span>
    </motion.div>
  );
}
