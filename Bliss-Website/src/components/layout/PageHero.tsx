import { Container, Eyebrow } from "@/components/ui";
import { Reveal } from "@/components/Reveal";

/** Consistent hero band for the secondary pages. */
export function PageHero({
  eyebrow,
  title,
  lead,
}: {
  eyebrow: string;
  title: React.ReactNode;
  lead: string;
}) {
  return (
    <header className="brand-mesh relative overflow-hidden border-b border-border/60">
      <Container className="max-w-3xl pb-16 pt-32 text-center sm:pt-36">
        <Reveal>
          <Eyebrow>{eyebrow}</Eyebrow>
        </Reveal>
        <Reveal delay={0.05}>
          <h1 className="mt-5 text-balance text-4xl font-semibold leading-[1.08] tracking-tight text-fg sm:text-5xl">
            {title}
          </h1>
        </Reveal>
        <Reveal delay={0.1}>
          <p className="mx-auto mt-5 max-w-2xl text-pretty text-lg leading-relaxed text-muted">
            {lead}
          </p>
        </Reveal>
      </Container>
    </header>
  );
}
