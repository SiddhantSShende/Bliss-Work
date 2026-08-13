import { Fragment } from "react";
import { motion, useReducedMotion, type Variants } from "framer-motion";
import { cn } from "@/lib/cn";

/* ──────────────────────────────────────────────────────────────────────────
   A responsive, theme-aware, animated SVG flow diagram.
   Define nodes + edges in a fixed viewBox coordinate space; the SVG scales to
   its container. Nodes pop in (staggered), edges draw themselves (pathLength),
   and "flow" edges carry a packet that travels the path (SMIL animateMotion).
   ────────────────────────────────────────────────────────────────────────── */

export type NodeKind = "client" | "gateway" | "service" | "db" | "infra" | "accent";
type Side = "top" | "bottom" | "left" | "right";
type EdgeColor = "muted" | "accent" | "brand";

export interface DiagNode {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  subtitle?: string;
  kind?: NodeKind;
}

export interface DiagEdge {
  from: string;
  to: string;
  fromSide?: Side;
  toSide?: Side;
  label?: string;
  dashed?: boolean;
  flow?: boolean;
  color?: EdgeColor;
}

const KIND_STYLE: Record<NodeKind, { fill: string; stroke: string; title: string; sub: string }> = {
  client: { fill: "var(--color-surface)", stroke: "var(--color-accent)", title: "var(--color-fg)", sub: "var(--color-muted)" },
  gateway: { fill: "var(--color-accent-soft)", stroke: "var(--color-accent)", title: "var(--color-accent-strong)", sub: "var(--color-accent)" },
  service: { fill: "var(--color-surface)", stroke: "var(--color-border)", title: "var(--color-fg)", sub: "var(--color-muted)" },
  db: { fill: "var(--color-surface-2)", stroke: "var(--color-border)", title: "var(--color-fg)", sub: "var(--color-muted)" },
  infra: { fill: "var(--color-surface-2)", stroke: "var(--color-border)", title: "var(--color-fg)", sub: "var(--color-muted)" },
  accent: { fill: "var(--color-fg)", stroke: "var(--color-fg)", title: "var(--color-bg)", sub: "var(--color-bg)" },
};

const EDGE_STROKE: Record<EdgeColor, string> = {
  muted: "var(--color-border)",
  accent: "var(--color-accent)",
  brand: "url(#flow-edge-grad)",
};

function anchor(n: DiagNode, side: Side): [number, number] {
  switch (side) {
    case "top": return [n.x + n.w / 2, n.y];
    case "bottom": return [n.x + n.w / 2, n.y + n.h];
    case "left": return [n.x, n.y + n.h / 2];
    case "right": return [n.x + n.w, n.y + n.h / 2];
  }
}

function normal(side: Side, k: number): [number, number] {
  switch (side) {
    case "top": return [0, -k];
    case "bottom": return [0, k];
    case "left": return [-k, 0];
    case "right": return [k, 0];
  }
}

/** Auto-pick the sides facing each other when not specified. */
function pickSides(a: DiagNode, b: DiagNode): [Side, Side] {
  const ac = [a.x + a.w / 2, a.y + a.h / 2];
  const bc = [b.x + b.w / 2, b.y + b.h / 2];
  const dx = bc[0] - ac[0];
  const dy = bc[1] - ac[1];
  if (Math.abs(dx) > Math.abs(dy)) {
    return dx > 0 ? ["right", "left"] : ["left", "right"];
  }
  return dy > 0 ? ["bottom", "top"] : ["top", "bottom"];
}

function edgePath(from: DiagNode, to: DiagNode, fromSide?: Side, toSide?: Side): string {
  const [fs, ts] = fromSide && toSide ? [fromSide, toSide] : pickSides(from, to);
  const [x1, y1] = anchor(from, fs);
  const [x2, y2] = anchor(to, ts);
  const dist = Math.hypot(x2 - x1, y2 - y1);
  const k = Math.max(36, dist * 0.42);
  const [nx1, ny1] = normal(fs, k);
  const [nx2, ny2] = normal(ts, k);
  return `M ${x1} ${y1} C ${x1 + nx1} ${y1 + ny1}, ${x2 + nx2} ${y2 + ny2}, ${x2} ${y2}`;
}

const drawVariants: Variants = {
  hidden: { pathLength: 0, opacity: 0 },
  show: (i: number) => ({
    pathLength: 1,
    opacity: 1,
    transition: { pathLength: { duration: 0.9, ease: "easeInOut", delay: 0.25 + i * 0.12 }, opacity: { duration: 0.2, delay: 0.25 + i * 0.12 } },
  }),
};

const nodeVariants: Variants = {
  hidden: { opacity: 0, scale: 0.9 },
  show: (i: number) => ({
    opacity: 1,
    scale: 1,
    transition: { duration: 0.4, ease: [0.22, 1, 0.36, 1], delay: i * 0.06 },
  }),
};

export function FlowDiagram({
  nodes,
  edges,
  width = 960,
  height = 520,
  className,
}: {
  nodes: DiagNode[];
  edges: DiagEdge[];
  width?: number;
  height?: number;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));

  return (
    <motion.svg
      viewBox={`0 0 ${width} ${height}`}
      className={cn("h-auto w-full", className)}
      role="img"
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, amount: 0.2 }}
    >
      <defs>
        <linearGradient id="flow-edge-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--color-brand-from)" />
          <stop offset="1" stopColor="var(--color-brand-to)" />
        </linearGradient>
        <marker id="flow-arrow-muted" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill="var(--color-muted)" />
        </marker>
        <marker id="flow-arrow-accent" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill="var(--color-accent)" />
        </marker>
      </defs>

      {/* edges */}
      {edges.map((e, i) => {
        const from = byId[e.from];
        const to = byId[e.to];
        if (!from || !to) return null;
        const d = edgePath(from, to, e.fromSide, e.toSide);
        const color: EdgeColor = e.color ?? "muted";
        const marker = color === "muted" ? "url(#flow-arrow-muted)" : "url(#flow-arrow-accent)";
        const mid = midpoint(from, to, e.fromSide, e.toSide);
        return (
          <Fragment key={`${e.from}-${e.to}-${i}`}>
            <motion.path
              id={`flow-edge-${i}`}
              d={d}
              fill="none"
              stroke={EDGE_STROKE[color]}
              strokeWidth={2}
              strokeLinecap="round"
              strokeDasharray={e.dashed ? "5 6" : undefined}
              markerEnd={marker}
              custom={i}
              variants={drawVariants}
            />
            {e.flow && !reduce && (
              <circle r={4} fill={color === "muted" ? "var(--color-accent)" : EDGE_STROKE[color]}>
                <animateMotion dur="2.6s" begin={`${0.8 + i * 0.15}s`} repeatCount="indefinite" rotate="auto">
                  <mpath href={`#flow-edge-${i}`} />
                </animateMotion>
              </circle>
            )}
            {e.label && (
              <motion.g custom={i} variants={drawVariants}>
                <rect
                  x={mid[0] - e.label.length * 3.2 - 6}
                  y={mid[1] - 9}
                  width={e.label.length * 6.4 + 12}
                  height={18}
                  rx={9}
                  fill="var(--color-bg)"
                  stroke="var(--color-border)"
                  strokeWidth={1}
                />
                <text x={mid[0]} y={mid[1] + 3.5} textAnchor="middle" fontSize={10.5} fontWeight={600} fill="var(--color-muted)">
                  {e.label}
                </text>
              </motion.g>
            )}
          </Fragment>
        );
      })}

      {/* nodes */}
      {nodes.map((n, i) => {
        const s = KIND_STYLE[n.kind ?? "service"];
        return (
          <motion.g key={n.id} custom={i} variants={nodeVariants}>
            {n.kind === "db" && (
              <ellipse cx={n.x + n.w / 2} cy={n.y + 7} rx={n.w / 2 - 2} ry={6} fill="none" stroke={s.stroke} strokeWidth={1.5} opacity={0.6} />
            )}
            <rect
              x={n.x}
              y={n.y}
              width={n.w}
              height={n.h}
              rx={14}
              fill={s.fill}
              stroke={s.stroke}
              strokeWidth={1.6}
            />
            <text
              x={n.x + n.w / 2}
              y={n.subtitle ? n.y + n.h / 2 - 3 : n.y + n.h / 2 + 4}
              textAnchor="middle"
              fontSize={13.5}
              fontWeight={700}
              fill={s.title}
            >
              {n.title}
            </text>
            {n.subtitle && (
              <text x={n.x + n.w / 2} y={n.y + n.h / 2 + 13} textAnchor="middle" fontSize={10.5} fontWeight={500} fill={s.sub}>
                {n.subtitle}
              </text>
            )}
          </motion.g>
        );
      })}
    </motion.svg>
  );
}

function midpoint(from: DiagNode, to: DiagNode, fromSide?: Side, toSide?: Side): [number, number] {
  const [fs, ts] = fromSide && toSide ? [fromSide, toSide] : pickSides(from, to);
  const [x1, y1] = anchor(from, fs);
  const [x2, y2] = anchor(to, ts);
  return [(x1 + x2) / 2, (y1 + y2) / 2];
}
