/**
 * Which build is this?
 *
 * Surfaced in Settings → About so a support conversation can start with "what
 * does it say under About?" instead of guessing whether a deploy landed. After
 * a deploy the SPA is only as new as the browser's last load of index.html, so
 * "I still see the bug" and "I'm on the old bundle" look identical without it.
 *
 * `VITE_BUILD_SHA` is injected by the `web-builder` service in
 * docker-compose.prod.yml, which reads it from `IMAGE_TAG` — the deployed commit
 * SHA that scripts/deploy-prod.sh exports. A local `npm run dev` or a hand-run
 * `docker compose up` has neither, and correctly reports "dev".
 */

// `import.meta.env` is Vite's build-time env (statically replaced). packages/app
// is consumed by both the web + electron Vite builds; cast so this compiles
// without pulling vite/client types into this shared package's tsconfig.
const VITE_ENV = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

/** Deployed commit SHA (short), or "dev" outside a deployed build. */
export const BUILD_SHA = VITE_ENV.VITE_BUILD_SHA?.trim() || "dev";

/** True when this bundle came out of the production deploy pipeline. */
export const IS_RELEASE_BUILD = BUILD_SHA !== "dev";
