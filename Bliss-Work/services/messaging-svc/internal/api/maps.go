package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sync/singleflight"

	mw "github.com/task-board/messaging-svc/internal/middleware"
)

// ─────────────────────────────────────────────────────────────────────────────
// Static map thumbnails for shared locations.
//
// ── Why the server fetches these instead of the browser ──────────────────────
//  1. The image ends up served from OUR origin, so none of the six places that
//     declare a CSP (two Caddyfiles, the web index.html, three desktop HTML
//     shells) need a new img-src host.
//  2. The user's IP never reaches the map provider. A chat app quietly telling
//     a third party "this person is looking at these coordinates" is exactly
//     the leak the feature is supposed to avoid.
//  3. The API key stays server-side instead of shipping in a JS bundle.
//  4. One cache entry serves the whole org — twenty people opening the same
//     pinned location cost one upstream request, not twenty.
//
// ── Degradation is the design, not an afterthought ───────────────────────────
// EVERY failure path returns 204 No Content, never a 5xx: no API key, bad
// upstream status, timeout, DNS failure, wrong content type. The client treats
// 204 as "no thumbnail available" and renders the coordinates card with an
// "Open in Maps" link, which is fully functional on its own. Location sharing
// therefore works with zero third-party setup.
// ─────────────────────────────────────────────────────────────────────────────

const (
	staticMapWidth   = 480
	staticMapHeight  = 240
	staticMapMaxSize = 2 << 20 // 2 MB — a 480x240 PNG is ~40 KB
	staticMapTimeout = 5 * time.Second
	staticMapTTL     = "public, max-age=86400"
)

// mapFlight collapses concurrent misses for the same coordinates into a single
// upstream fetch.
var mapFlight singleflight.Group

// staticMap returns a cached map thumbnail for a coordinate, or 204.
func (s *Server) staticMap(w http.ResponseWriter, r *http.Request) {
	if s.mapsCfg.APIKey == "" {
		// Feature not configured. This is a supported state, not an error.
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// ── Validation is also the SSRF boundary ─────────────────────────────────
	// Everything that reaches the upstream URL below is a re-formatted float or
	// int parsed here. No user-supplied STRING is ever interpolated, so there is
	// no way to steer the request at another host or path.
	lat, ok := parseCoord(r.URL.Query().Get("lat"), 90)
	if !ok {
		writeErrR(w, r, http.StatusBadRequest, "lat must be between -90 and 90")
		return
	}
	lng, ok := parseCoord(r.URL.Query().Get("lng"), 180)
	if !ok {
		writeErrR(w, r, http.StatusBadRequest, "lng must be between -180 and 180")
		return
	}
	zoom := 15
	if raw := r.URL.Query().Get("z"); raw != "" {
		z, err := strconv.Atoi(raw)
		if err != nil || z < 1 || z > 19 {
			writeErrR(w, r, http.StatusBadRequest, "z must be between 1 and 19")
			return
		}
		zoom = z
	}

	// Round to 5 decimals (~1 m). Bounds the cache keyspace so nearby viewers
	// of the same pin share an entry instead of each minting a new one.
	latS := strconv.FormatFloat(lat, 'f', 5, 64)
	lngS := strconv.FormatFloat(lng, 'f', 5, 64)

	sum := sha256.Sum256([]byte(fmt.Sprintf("%s|%d|%dx%d|%s|%s",
		s.mapsCfg.Provider, zoom, staticMapWidth, staticMapHeight, latS, lngS)))
	key := hex.EncodeToString(sum[:])

	if f, fi, err := s.blobs.CacheGet("maps", key); err == nil {
		defer f.Close()
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", staticMapTTL)
		http.ServeContent(w, r, "", fi.ModTime(), f)
		return
	}

	// Miss. One fetch per key, however many callers are waiting.
	if _, err, _ := mapFlight.Do(key, func() (any, error) {
		return nil, s.fetchStaticMap(r.Context(), key, latS, lngS, zoom)
	}); err != nil {
		s.log.Warn("static map unavailable", "err", err,
			"request_id", mw.RequestIDFromContext(r.Context()))
		w.WriteHeader(http.StatusNoContent)
		return
	}

	f, fi, err := s.blobs.CacheGet("maps", key)
	if err != nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", staticMapTTL)
	http.ServeContent(w, r, "", fi.ModTime(), f)
}

// fetchStaticMap pulls one tile from the configured provider and caches it.
func (s *Server) fetchStaticMap(ctx context.Context, key, lat, lng string, zoom int) error {
	ctx, cancel := context.WithTimeout(ctx, staticMapTimeout)
	defer cancel()

	url, err := s.staticMapURL(lat, lng, zoom)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("map provider returned %d", resp.StatusCode)
	}
	// Never cache whatever an error page happened to contain.
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "image/") {
		return fmt.Errorf("map provider returned content-type %q", ct)
	}
	return s.blobs.CachePut("maps", key, io.LimitReader(resp.Body, staticMapMaxSize+1), staticMapMaxSize)
}

// staticMapURL builds the provider request. lat/lng arrive as already-validated,
// re-formatted numeric strings; only the API key is passed through, and it is
// operator-supplied, not user-supplied.
func (s *Server) staticMapURL(lat, lng string, zoom int) (string, error) {
	switch s.mapsCfg.Provider {
	case "geoapify", "":
		return fmt.Sprintf(
			"https://maps.geoapify.com/v1/staticmap?style=osm-bright&width=%d&height=%d"+
				"&zoom=%d&center=lonlat:%s,%s&marker=lonlat:%s,%s;type:material;color:%%23aa3939;size:small&apiKey=%s",
			staticMapWidth, staticMapHeight, zoom, lng, lat, lng, lat, s.mapsCfg.APIKey), nil
	case "maptiler":
		return fmt.Sprintf(
			"https://api.maptiler.com/maps/streets-v2/static/%s,%s,%d/%dx%d.png?key=%s",
			lng, lat, zoom, staticMapWidth, staticMapHeight, s.mapsCfg.APIKey), nil
	default:
		return "", fmt.Errorf("unknown map provider %q", s.mapsCfg.Provider)
	}
}

// parseCoord parses a coordinate and range-checks it. Rejects NaN and ±Inf,
// which would otherwise format into the upstream URL as "NaN".
func parseCoord(raw string, limit float64) (float64, bool) {
	if raw == "" {
		return 0, false
	}
	v, err := strconv.ParseFloat(raw, 64)
	if err != nil || v != v || v < -limit || v > limit {
		return 0, false
	}
	return v, true
}
