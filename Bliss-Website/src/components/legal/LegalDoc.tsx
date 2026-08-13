import { type ReactNode } from "react";
import { Card } from "@/components/ui";
import { Reveal } from "@/components/Reveal";

/** A block of legal content. Pages describe their document as data and this
 *  module renders it, so Privacy / Terms / DPA all read and look identical. */
export type Block =
  | { type: "p"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "group"; heading: string; items: string[] }
  | { type: "sub"; heading: string; text: string }
  | { type: "node"; node: ReactNode };

export interface LegalSection {
  n: number;
  title: string;
  body: Block[];
}

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="space-y-2.5">
      {items.map((it, i) => (
        <li key={i} className="flex gap-3 text-[15px] leading-relaxed text-muted">
          <span className="mt-[0.6rem] h-1.5 w-1.5 shrink-0 rounded-full bg-gradient-to-br from-brand-from to-brand-to" />
          <span>{it}</span>
        </li>
      ))}
    </ul>
  );
}

/** Renders the body blocks of a single legal section. */
export function LegalBlocks({ blocks }: { blocks: Block[] }) {
  return (
    <div className="space-y-4">
      {blocks.map((b, i) => {
        switch (b.type) {
          case "p":
            return (
              <p key={i} className="text-[15px] leading-relaxed text-muted">
                {b.text}
              </p>
            );
          case "ul":
            return <Bullets key={i} items={b.items} />;
          case "group":
            return (
              <div key={i} className="space-y-2.5">
                <h3 className="text-sm font-semibold tracking-tight text-fg">{b.heading}</h3>
                <Bullets items={b.items} />
              </div>
            );
          case "sub":
            return (
              <div key={i} className="space-y-1.5">
                <h3 className="text-sm font-semibold tracking-tight text-fg">{b.heading}</h3>
                <p className="text-[15px] leading-relaxed text-muted">{b.text}</p>
              </div>
            );
          case "node":
            return <div key={i}>{b.node}</div>;
        }
      })}
    </div>
  );
}

/** Renders a numbered list of legal sections as cards. */
export function LegalSections({ sections }: { sections: LegalSection[] }) {
  return (
    <div className="space-y-5">
      {sections.map((s) => (
        <Reveal key={s.n}>
          <Card id={`section-${s.n}`} className="scroll-mt-28 p-7 sm:p-8">
            <h2 className="text-lg font-semibold tracking-tight text-fg sm:text-xl">
              <span className="text-accent">{s.n}.</span> {s.title}
            </h2>
            <div className="mt-4">
              <LegalBlocks blocks={s.body} />
            </div>
          </Card>
        </Reveal>
      ))}
    </div>
  );
}

/** Optional intro card shown above the numbered sections. */
export function LegalIntro({ paragraphs }: { paragraphs: string[] }) {
  return (
    <Card className="space-y-4 p-7 sm:p-8">
      {paragraphs.map((t, i) => (
        <p key={i} className="text-[15px] leading-relaxed text-muted">
          {t}
        </p>
      ))}
    </Card>
  );
}
