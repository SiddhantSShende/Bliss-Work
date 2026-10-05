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

  // Authentication is established by the app after session restoration. Until
  // then, every route starts with the same fixed theme; ThemeProvider hydrates
  // the saved preference only after the session is confirmed.
  document.documentElement.classList.add(...THEME_CLASSES[DEFAULT_THEME]);
})();
