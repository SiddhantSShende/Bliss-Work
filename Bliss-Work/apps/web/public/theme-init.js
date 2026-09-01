(() => {
  // Keep in lock-step with packages/ui/src/theme/themes.ts — this script runs
  // before any bundler does, so it can't import that module and duplicates
  // its class map by hand instead. "blue" is the app's original palette and
  // needs no extra class; every other family layers one on top of light/dark.
  const THEME_CLASSES = {
    default: ["light", "default"],
    "default-dark": ["dark", "default"],
    blue: ["light"],
    "blue-dark": ["dark"],
    "rose": ["light", "rose"],
    "rose-dark": ["dark", "rose"],
    purple: ["light", "purple"],
    "purple-dark": ["dark", "purple"],
    teal: ["light", "teal"],
    "teal-dark": ["dark", "teal"],
  };
  const systemTheme = () =>
    window.matchMedia("(prefers-color-scheme: dark)").matches ? "default-dark" : "default";

  // Login and Signup are FIXED to the default theme, regardless of what the
  // signed-in user (or a previous session on this device) picked in
  // Settings — kept in lock-step with the route list
  // packages/app/src/lib/authThemeLock.tsx uses for the same rule once React
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

  function storedOrSystemTheme() {
    try {
      const stored = localStorage.getItem("tb-theme");
      return Object.prototype.hasOwnProperty.call(THEME_CLASSES, stored ?? "")
        ? stored
        : systemTheme();
    } catch {
      return systemTheme();
    }
  }

  const theme = isAuthRoute() ? systemTheme() : storedOrSystemTheme();
  document.documentElement.classList.add(...THEME_CLASSES[theme]);
})();
