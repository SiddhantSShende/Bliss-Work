import { Link } from "react-router-dom";
import { Download, Globe } from "lucide-react";
import { Wordmark } from "@/components/brand/Logo";
import { Container, Button, ButtonLink } from "@/components/ui";
import { useDownload } from "@/components/download/DownloadProvider";
import { NAV_LINKS, LEGAL_LINKS, SITE } from "@/config/site";

export function Footer() {
  const { open } = useDownload();
  return (
    <footer className="border-t border-border/70 bg-surface/40">
      <Container className="py-14">
        <div className="flex flex-col gap-10 md:flex-row md:items-start md:justify-between">
          <div className="max-w-sm">
            <Wordmark />
            <p className="mt-4 text-sm leading-relaxed text-muted">{SITE.description}</p>
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <Button onClick={open} size="sm">
                <Download size={15} />
                Get the App
              </Button>
              <ButtonLink
                href={SITE.webApp}
                target="_blank"
                rel="noreferrer"
                variant="secondary"
                size="sm"
              >
                <Globe size={15} />
                Operate with Browser
              </ButtonLink>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-x-12 gap-y-8 sm:gap-x-16">
            <nav className="flex flex-col gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted/70">
                Explore
              </span>
              {NAV_LINKS.map((l) => (
                <Link
                  key={l.to}
                  to={l.to}
                  className="text-sm font-medium text-muted transition-colors hover:text-fg"
                >
                  {l.label}
                </Link>
              ))}
            </nav>
            <nav className="flex flex-col gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted/70">
                Legal
              </span>
              {LEGAL_LINKS.map((l) => (
                <Link
                  key={l.to}
                  to={l.to}
                  className="text-sm font-medium text-muted transition-colors hover:text-fg"
                >
                  {l.label}
                </Link>
              ))}
            </nav>
          </div>
        </div>

        <div className="mt-12 flex flex-col items-center justify-between gap-3 border-t border-border/70 pt-6 text-xs text-muted sm:flex-row">
          <p>
            © {SITE.year} {SITE.name}. All rights reserved.
          </p>
          <p className="text-muted/80">
            A product by <span className="font-semibold text-fg">{SITE.company}</span>
          </p>
        </div>
      </Container>
    </footer>
  );
}
