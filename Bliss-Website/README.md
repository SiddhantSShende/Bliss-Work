# BlissWork — Marketing Website

The public marketing site for **BlissWork**, the enterprise communication network.

This is a **standalone project**, intentionally independent of the BlissWork
application codebase. It only mirrors the app's visual identity (the OKLch design
tokens, Inter typography, the glass + blue→violet gradient look) so the two feel
like one brand.

## Stack

- **React 19** + **Vite 6** + **TypeScript**
- **Tailwind CSS v4** (brand tokens ported from the app)
- **Framer Motion** for animations and the custom animated diagrams
- **React Router 7** (Home · Userflow · Architecture · About)
- **lucide-react** icons, **Inter** bundled via `@fontsource`

## Develop

```bash
npm install
npm run dev        # http://localhost:5173
```

## Build

```bash
npm run build      # type-check + production build → dist/
npm run preview    # preview the production build → http://localhost:4173
```

## Deploy

Pushing to `main` deploys automatically:
[`.github/workflows/deploy-site.yml`](.github/workflows/deploy-site.yml) SSHes to
the VPS and runs [`scripts/deploy-site.sh`](scripts/deploy-site.sh), which pulls,
`npm ci`, typechecks, builds into a staging directory, and rsyncs the result into
`dist/`. Caddy bind-mounts that `dist/` read-only at `/srv/blisswork` and serves
it with a catch-all rewrite to `index.html` for SPA routing — so writing the
files *is* the deploy; there is no restart.

The staging-then-rsync dance is not incidental: `dist/` must keep its inode or
the bind mount breaks, and an in-place `vite build` would 404 the live site for
the couple of seconds it takes to rewrite. A failed build leaves the deployed
site untouched.

Run it by hand with `bash scripts/deploy-site.sh`; roll back with
`DEPLOY_REF=<sha> bash scripts/deploy-site.sh`.

## "Get the App" downloads

The download flow lives in [`src/config/downloads.ts`](src/config/downloads.ts).

Installers are produced by the BlissWork **app** repo (`Bliss-Work`) via its
`release.yml` matrix — Windows `.exe`, macOS `.dmg` for Intel + Apple Silicon,
Linux `.AppImage` / `.deb` — and hosted on **our own VPS, not GitHub Releases**
(the app repo is private, so a GitHub feed would need a token embedded in every
installer). That workflow rsyncs them to `/home/ubuntu/BlissWork/downloads`,
which nginx serves at `/downloads/*` for both this site and
`communication.rnrtechs.com`.

electron-builder emits **stable, version-less** artifact names (e.g.
`BlissWork-windows-x64.exe`), so the `/downloads/<name>` URLs in `downloads.ts`
never change and always resolve to the newest release. Every green build of the
app repo's `main` republishes them, so this repo needs no change when the desktop
app is updated.

> **Installers are not part of this repo or its build output.** They used to be
> mirrored in `public/downloads/` and `dist/downloads/`, which meant every
> `npm run build` deleted the live installer set until the next release run.
> Don't reintroduce either directory. To point downloads elsewhere entirely
> (S3 / CDN), edit `RELEASE_BASE` in `downloads.ts` — and note the near-duplicate
> config at `Bliss-Work/packages/app/src/lib/downloads.ts`, which must be changed
> in step.

That same directory doubles as the **electron-updater feed** (`latest.yml`,
`latest-mac.yml`, `latest-linux.yml`), which is why nothing outside the release
pipeline may write to it.

## Structure

```
src/
  components/
    brand/        Logo, Wordmark, OS glyphs
    diagram/      FlowDiagram (animated SVG), StepFlow (journeys)
    download/     DownloadProvider + modal (platform picker)
    layout/       Navbar, Footer, PageHero
    mockup/       Product mockups (app window, sticky notes)
    ui.tsx        Button, Card, Badge, Avatar, Section, Container…
    Reveal.tsx    scroll-reveal helpers
  config/         site.ts (nav), downloads.ts
  pages/          Home, Userflow, Architect, About
  theme/          ThemeProvider (light/dark)
  index.css       ported brand tokens + helpers
```
