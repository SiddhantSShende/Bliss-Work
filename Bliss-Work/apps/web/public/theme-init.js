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
  try {
    const stored = localStorage.getItem("tb-theme");
    const theme = Object.prototype.hasOwnProperty.call(THEME_CLASSES, stored ?? "")
      ? stored
      : systemTheme();
    document.documentElement.classList.add(...THEME_CLASSES[theme]);
  } catch {
    document.documentElement.classList.add(...THEME_CLASSES[systemTheme()]);
  }
})();
