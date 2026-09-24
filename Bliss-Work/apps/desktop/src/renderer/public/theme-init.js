(() => {
  // Keep in lock-step with packages/ui/src/theme/themes.ts — this script runs
  // before any bundler does, so it can't import that module and duplicates
  // its class map by hand instead. "blue" is the app's original palette and
  // needs no extra class; every other family layers one on top of light/dark.
  const THEME_CLASSES = {
    bluePurple: ["light", "bluePurple"],
    "bluePurple-dark": ["dark", "bluePurple"],
    blue: ["light"],
    "blue-dark": ["dark"],
    rose: ["light", "rose"],
    "rose-dark": ["dark", "rose"],
    purple: ["light", "purple"],
    "purple-dark": ["dark", "purple"],
    teal: ["light", "teal"],
    "teal-dark": ["dark", "teal"],
    lime: ["light", "lime"],
    "lime-dark": ["dark", "lime"],
  };

  // The fixed Light + Blue/Purple default — never the OS/browser's dark-mode
  // preference. Kept in lock-step with packages/ui/src/theme/ThemeProvider.tsx
  // (`defaultThemeFor(false)`), which resolves its own initial React state the
  // same way a moment after this script runs, so there is no flash between
  // this pre-paint class and the one React settles on.
  const DEFAULT_THEME = "bluePurple";

  // Login and Signup are FIXED to the default theme, regardless of what the
  // signed-in user (or a previous session on this device) picked in
  // Settings — kept in lock-step with the route list
  // packages/app/src/App.tsx's ThemedTree uses for the same rule once React
  // has mounted (that component is what keeps enforcing this after first
  // paint, and what restores the real theme on navigating away). Checked
  // against BOTH pathname (web's BrowserRouter) and hash (desktop's
  // HashRouter) since this one script ships to both apps unchanged.
  const AUTH_PATHS = ["/login", "/onboarding"];
  function isAuthRoute() {
    const path = (location.pathname || "").split("?")[0];
    const hash = (location.hash || "").replace(/^#/, "").split("?")[0];
    return AUTH_PATHS.indexOf(path) !== -1 || AUTH_PATHS.indexOf(hash) !== -1;
  }

  // A theme picked in Settings, or Dark Mode, still applies normally for the
  // rest of that session and every session after — see ThemeProvider's
  // `setTheme`/`toggle`. Only a brand-new visitor (nothing stored yet, or a
  // stored value from before this theme system existed) falls back to
  // DEFAULT_THEME here.
  function storedOrDefaultTheme() {
    try {
      const stored = localStorage.getItem("tb-theme");
      return Object.prototype.hasOwnProperty.call(THEME_CLASSES, stored ?? "") ? stored : DEFAULT_THEME;
    } catch {
      return DEFAULT_THEME;
    }
  }

  const theme = isAuthRoute() ? DEFAULT_THEME : storedOrDefaultTheme();
  document.documentElement.classList.add(...THEME_CLASSES[theme]);

  if (!isAuthRoute()) {
    try {
      const raw = localStorage.getItem("tb-custom-theme");
      const custom = raw ? JSON.parse(raw) : null;
      const valid = custom && typeof custom.name === "string" && custom.name.trim() && Array.isArray(custom.colors) && custom.colors.length >= 1 && custom.colors.length <= 3 && custom.colors.every((color) => /^#[\da-fA-F]{6}$/.test(color));
      if (valid && localStorage.getItem("tb-custom-theme-active") === "true") {
        const colors = custom.colors;
        const first = colors[0];
        const last = colors[colors.length - 1];
        const gradient = colors.length === 1 ? first : `linear-gradient(135deg, ${colors.join(", ")})`;
        const root = document.documentElement;
        root.classList.add("custom-theme");
        root.style.setProperty("--color-accent", first);
        root.style.setProperty("--color-accent-strong", first);
        root.style.setProperty("--color-accent-fg", "#ffffff");
        root.style.setProperty("--color-accent-soft", `color-mix(in srgb, ${first} 12%, white)`);
        root.style.setProperty("--color-brand-from", first);
        root.style.setProperty("--color-brand-mid", colors[1] || last);
        root.style.setProperty("--color-brand-to", last);
        root.style.setProperty("--color-brand-gradient", gradient);
      }
    } catch {
      // Invalid custom theme data is ignored until React can validate it.
    }
  }
})();
