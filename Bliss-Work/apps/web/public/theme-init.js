(() => {
  const THEME_CLASSES = {
    light: ["light"],
    dark: ["dark"],
    "graphite-lime": ["light", "lime"],
    "graphite-lime-dark": ["dark", "lime"],
  };
  const systemTheme = () =>
    window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
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
