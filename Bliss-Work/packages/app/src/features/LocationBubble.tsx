import { ExternalLink, MapPin } from "lucide-react";
import { useStaticMap } from "../lib/useStaticMap";
import { formatCoords, mapsLink } from "../lib/mapsLink";
import type { LocationEnvelope } from "../lib/chatEnvelope";

/**
 * A shared location.
 *
 * The design is deliberately inverted from what you might expect: the
 * COORDINATES CARD is the product, and the map thumbnail is decoration layered
 * on top when available. Location sharing therefore works with no map provider
 * account, no API key and no outbound network access — which is the state most
 * deployments will be in, and all of them are in on day one.
 */
export function LocationBubble({
  env,
  mine,
}: {
  env: LocationEnvelope;
  mine: boolean;
}) {
  const { url } = useStaticMap(env.lat, env.lng);
  const href = mapsLink(env.lat, env.lng, env.label);
  const title = env.label || "Shared location";

  return (
    <div
      className={`flex w-[min(20rem,80vw)] flex-col overflow-hidden rounded-2xl text-sm shadow-[0_2px_10px_-4px_rgba(40,30,90,0.25)] ${
        mine
          ? "rounded-br-md bg-gradient-to-br from-brand-from to-brand-to text-accent-fg"
          : "rounded-bl-md bg-surface text-fg ring-1 ring-border/60"
      }`}
    >
      {url ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="relative block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          aria-label={`Open ${title} in Maps`}
        >
          <img
            src={url}
            alt={`Map showing ${title}`}
            width={480}
            height={240}
            className="block h-auto w-full object-cover"
            loading="lazy"
          />
          {/* The provider's own marker is small; this makes the pin unmissable. */}
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <MapPin size={26} className="drop-shadow-md" fill="#aa3939" color="#ffffff" />
          </span>
        </a>
      ) : null}

      <div className="flex items-center gap-2.5 px-3.5 py-2.5">
        {!url && (
          <div
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
              mine ? "bg-accent-fg/15" : "bg-accent-soft text-accent"
            }`}
          >
            <MapPin size={18} />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{title}</div>
          <div className={`truncate text-xs ${mine ? "text-accent-fg/70" : "text-muted"}`}>
            {formatCoords(env.lat, env.lng)}
            {env.accuracy !== undefined && env.accuracy > 0
              ? ` · ±${Math.round(env.accuracy)} m`
              : ""}
          </div>
        </div>
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          title="Open in Maps"
          className={`inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium transition-colors ${
            mine ? "bg-accent-fg/15 hover:bg-accent-fg/25" : "border border-border text-fg hover:bg-surface-2"
          }`}
        >
          <ExternalLink size={13} /> Open
        </a>
      </div>
    </div>
  );
}
