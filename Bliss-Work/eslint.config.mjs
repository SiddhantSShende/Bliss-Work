// Flat ESLint config for the monorepo. Intentionally focused: the headline rule
// is `react/no-danger` (error) — the audit's defense-in-depth guard that bans
// dangerouslySetInnerHTML so a future contributor can't introduce an XSS sink.
// react-hooks rules catch real hook bugs. The rest stays light so lint signals
// the security/correctness rule, not pre-existing style nits.
import tseslint from "typescript-eslint";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/out/**",
      "**/build/**",
      "**/release/**",
      "**/node_modules/**",
      "**/.shot/**",
      "**/.ui-verify/**",
      "**/*.config.{js,cjs,mjs,ts}",
      "scripts/**",
    ],
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true }, sourceType: "module" },
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { react, "react-hooks": reactHooks },
    settings: { react: { version: "detect" } },
    rules: {
      "react/no-danger": "error",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
);
