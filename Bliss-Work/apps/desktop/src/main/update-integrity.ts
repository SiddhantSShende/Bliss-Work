/**
 * Defense-in-depth check for the desktop auto-updater.
 *
 * Today the ONLY thing that verifies a downloaded installer is the sha512 in
 * `latest.yml` — a file fetched from the exact same host
 * (communication.rnrtechs.com/downloads) as the installer itself (see
 * updater.ts and docs/DEPLOY.md, "The update feed"). The app is unsigned
 * (apps/desktop/SIGNING.md), so there is no independent publisher-identity
 * check either. That means a single compromised host — or a compromised
 * release pipeline that writes to it — is sufficient to push a malicious
 * auto-installed update to every client: the "integrity check" would just be
 * checking the attacker's file against the attacker's own hash.
 *
 * This module adds a SECOND, independently-hosted source of truth for the
 * expected hash. If it is configured and disagrees with the primary feed,
 * that is real evidence the primary feed was tampered with, and the caller
 * should refuse to install. If it is unreachable, not configured, or doesn't
 * mention this artifact, we fall back to the pre-existing single-source
 * trust model — not a regression, just not yet a second opinion — and say so
 * loudly in the caller's logs, because the point is for that gap to stay
 * visible until it's provisioned.
 *
 * ⚠️ TB_UPDATE_MANIFEST_MIRROR_URL is NOT set anywhere in this repo's infra
 * today (checked INFRASTRUCTURE.md, docker-compose.prod.yml, infra/nginx,
 * infra/caddy). `blisswork.rnrtechs.com` looks like a second host but is NOT
 * one for this purpose: `infra/nginx/default.conf`'s `/downloads/` location
 * is served by a single catch-all `server_name _` block, from the SAME
 * bind-mounted directory (`/home/ubuntu/BlissWork/downloads`, see
 * docker-compose.prod.yml) for both `communication.rnrtechs.com` and
 * `blisswork.rnrtechs.com` — same filesystem, same nginx, same release
 * pipeline. Mirroring the manifest there would just check the attacker's
 * file against the attacker's own hash a second time. A real fix needs a
 * genuinely independent origin — e.g. a raw file in a public GitHub repo, or
 * an object-storage bucket/CDN under separate credentials — publishing the
 * manifest there every release is infra + pipeline work for a human, out of
 * scope here.
 *
 * Contract for whatever gets hosted at that URL: a small JSON document
 * (deliberately not electron-builder's YAML — see the "no YAML parser"
 * reasoning in scripts/regen-update-manifest.mjs, which this mirrors) of the
 * shape:
 *   { "version": "0.1.234",
 *     "files": { "BlissWork-windows-x64.exe": "<base64 sha512>", ... } }
 * where each hash is the same "sha512" electron-builder writes into
 * latest*.yml for that artifact — published somewhere independent every
 * release, alongside them.
 */

const FETCH_TIMEOUT_MS = 10_000;

export interface SecondSourceManifest {
  version: string;
  files: Record<string, string>;
}

function isSecondSourceManifest(value: unknown): value is SecondSourceManifest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.version !== "string") return false;
  if (typeof candidate.files !== "object" || candidate.files === null) return false;
  return Object.values(candidate.files as Record<string, unknown>).every((hash) => typeof hash === "string");
}

export type IntegrityCheckResult =
  | { verified: true }
  /** A configured mirror actively disagrees with the primary feed — real
   *  evidence of tampering. The caller should refuse to install. */
  | { verified: false; blocking: true; reason: string }
  /** No second opinion was available (not configured, unreachable, or
   *  silent on this artifact/version). Not evidence of tampering — the
   *  caller should fall back to the primary feed's own check. */
  | { verified: false; blocking: false; reason: string };

export interface IntegrityCheckParams {
  /** TB_UPDATE_MANIFEST_MIRROR_URL, or undefined if not provisioned. */
  mirrorUrl: string | undefined;
  version: string;
  artifactFileName: string;
  expectedSha512: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Compare the update electron-updater is about to install against an
 * independently-hosted copy of its expected hash. Never throws — every
 * failure mode resolves to a non-blocking result so a broken or unprovisioned
 * mirror can't brick auto-update for every user.
 */
export async function checkSecondSource(params: IntegrityCheckParams): Promise<IntegrityCheckResult> {
  const { mirrorUrl, version, artifactFileName, expectedSha512, fetchImpl = fetch } = params;

  if (!mirrorUrl) {
    return {
      verified: false,
      blocking: false,
      reason: "no second-source manifest configured (TB_UPDATE_MANIFEST_MIRROR_URL is unset)",
    };
  }

  let parsed: unknown;
  try {
    const res = await fetchImpl(mirrorUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      return { verified: false, blocking: false, reason: `second source returned HTTP ${res.status}` };
    }
    parsed = await res.json();
  } catch (e) {
    return {
      verified: false,
      blocking: false,
      reason: `second source unreachable: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (!isSecondSourceManifest(parsed)) {
    return { verified: false, blocking: false, reason: "second source returned a malformed manifest" };
  }

  if (parsed.version !== version) {
    return {
      verified: false,
      blocking: false,
      reason: `second source is for version ${parsed.version}, expected ${version}`,
    };
  }

  const mirrorHash = parsed.files[artifactFileName];
  if (!mirrorHash) {
    return { verified: false, blocking: false, reason: `second source has no entry for ${artifactFileName}` };
  }

  if (mirrorHash !== expectedSha512) {
    return {
      verified: false,
      blocking: true,
      reason: `sha512 mismatch for ${artifactFileName}: primary feed and second source disagree`,
    };
  }

  return { verified: true };
}
