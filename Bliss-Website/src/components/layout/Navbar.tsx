import { useEffect, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Download, Globe, Menu, Moon, Sun, X } from "lucide-react";
import { Wordmark } from "@/components/brand/Logo";
import { Button, ButtonLink } from "@/components/ui";
import { useDownload } from "@/components/download/DownloadProvider";
import { useTheme } from "@/theme/ThemeProvider";
import { NAV_LINKS, SITE } from "@/config/site";
import { cn } from "@/lib/cn";

export function Navbar() {
  const { theme, toggle } = useTheme();
  const { getApp } = useDownload();
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // close mobile menu on route change
  useEffect(() => setMenuOpen(false), [location.pathname]);

  return (
    <header className="fixed inset-x-0 top-0 z-40">
      <div
        className={cn(
          "mx-auto mt-3 flex max-w-6xl items-center justify-between gap-3 rounded-2xl px-4 py-2.5 transition-all duration-300 sm:px-5",
          "mx-3 sm:mx-auto",
          scrolled ? "glass shadow-soft" : "border border-transparent",
        )}
      >
        <Link to="/" aria-label="BlissWork home" className="shrink-0">
          <Wordmark />
        </Link>

        {/* desktop nav */}
        <nav className="hidden items-center gap-1 lg:flex">
          {NAV_LINKS.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.to === "/"}
              className={({ isActive }) =>
                cn(
                  "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                  isActive ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-2 hover:text-fg",
                )
              }
            >
              {l.label}
            </NavLink>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <button
            onClick={toggle}
            aria-label="Toggle theme"
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl text-muted transition-colors hover:bg-surface-2 hover:text-fg"
          >
            {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <ButtonLink
            href={SITE.webApp}
            target="_blank"
            rel="noreferrer"
            variant="secondary"
            size="sm"
            className="hidden lg:inline-flex"
          >
            <Globe size={15} />
            Operate with Browser
          </ButtonLink>
          <Button onClick={getApp} size="sm" className="hidden sm:inline-flex">
            <Download size={15} />
            Get the App
          </Button>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Menu"
            aria-expanded={menuOpen}
            aria-controls="mobile-nav-menu"
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl text-fg transition-colors hover:bg-surface-2 lg:hidden"
          >
            {menuOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </div>

      {/* mobile menu */}
      <AnimatePresence>
        {menuOpen && (
          <motion.nav
            id="mobile-nav-menu"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
            className="glass mx-3 mt-2 flex flex-col gap-1 rounded-2xl p-2 shadow-card lg:hidden"
          >
            {NAV_LINKS.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                end={l.to === "/"}
                className={({ isActive }) =>
                  cn(
                    "rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
                    isActive ? "bg-accent-soft text-accent" : "text-fg hover:bg-surface-2",
                  )
                }
              >
                {l.label}
              </NavLink>
            ))}
            <Button
              onClick={() => {
                setMenuOpen(false);
                getApp();
              }}
              className="mt-1 w-full"
            >
              <Download size={15} />
              Get the App
            </Button>
            <ButtonLink
              href={SITE.webApp}
              target="_blank"
              rel="noreferrer"
              variant="secondary"
              onClick={() => setMenuOpen(false)}
              className="w-full"
            >
              <Globe size={15} />
              Operate with Browser
            </ButtonLink>
          </motion.nav>
        )}
      </AnimatePresence>
    </header>
  );
}
