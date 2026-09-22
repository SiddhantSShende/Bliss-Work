package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sync/singleflight"

	mw "github.com/task-board/messaging-svc/internal/middleware"
)

// ─────────────────────────────────────────────────────────────────────────────
// Naming and finding a shared location.
//
// Two endpoints, both siblings of staticMap and built on the same three rules:
// the provider is called from the SERVER (so the API key stays off the client
// and the user's IP never reaches the provider), the answer is cached by a
// rounded key (so a whole org sharing one pin costs one upstream call), and
// EVERY failure is a 204 rather than a 5xx, because both features are garnish
// on something that already works.
//
//   GET /maps/reverse?lat&lng  → {"label": "12 Rue Foo, Paris"} | 204
//   GET /maps/whereami         → {"lat":…, "lng":…, "accuracy":…, "label":…} | 204
//
// ── Why reverse geocoding exists ─────────────────────────────────────────────
// LocationEnvelope has always had a `label`, and both the bubble and the Apple
// Maps deep link render it — but nothing ever SET it, so every shared location
// read "Shared location" and the Maps link carried no place name. On Apple
// platforms that is the entire difference between a tagged pin and a bare
// coordinate.
//
// ── Why whereami exists ──────────────────────────────────────────────────────
// Chromium's navigator.geolocation needs a network location provider, and
// Electron ships without the Google API key that one requires. macOS and
// Windows have OS-level providers to fall back on; a Linux desktop has neither,
// so getCurrentPosition simply fails there. A coarse IP fix is a far better
// answer than "Couldn't determine your location" — as long as it is HONEST
// about being coarse, which is what the large `accuracy` is for.
// ─────────────────────────────────────────────────────────────────────────────

const (
	geocodeTimeout = 5 * time.Second
	geocodeMaxSize = 64 << 10 // a formatted address is a few hundred bytes
	// City-level is the best an IP lookup can honestly claim. The client sends
	// this as the envelope's accuracy so the bubble renders "±25 km" rather
	// than implying GPS precision.
	ipAccuracyMeters = 25000
)

// geoFlight collapses concurrent misses for the same key into one upstream call.
var geoFlight singleflight.Group

// reverseGeocode names a coordinate, or answers 204 when it cannot.
func (s *Server) reverseGeocode(w http.ResponseWriter, r *http.Request) {
	if s.mapsCfg.APIKey == "" {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// Same SSRF boundary as staticMap: only re-formatted numbers reach the
	// upstream URL, never a user-supplied string.
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

	// 4 decimals (~11 m) rather than the tile cache's 5: a street address does
	// not change over a metre, and the coarser key means more shared hits.
	latS := strconv.FormatFloat(lat, 'f', 4, 64)
	lngS := strconv.FormatFloat(lng, 'f', 4, 64)
	sum := sha256.Sum256([]byte(fmt.Sprintf("rev|%s|%s|%s", s.mapsCfg.Provider, latS, lngS)))
	key := hex.EncodeToString(sum[:])

	if label, ok := s.cachedLabel(key); ok {
		writeLabel(w, label)
		return
	}

	v, err, _ := geoFlight.Do(key, func() (any, error) {
		return s.fetchReverse(r.Context(), key, latS, lngS)
	})
	if err != nil {
		s.log.Warn("reverse geocode unavailable", "err", err,
			"request_id", mw.RequestIDFromContext(r.Context()))
		w.WriteHeader(http.StatusNoContent)
		return
	}
	label, _ := v.(string)
	if label == "" {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeLabel(w, label)
}

type whereamiResponse struct {
	Lat      float64 `json:"lat"`
	Lng      float64 `json:"lng"`
	Accuracy int     `json:"accuracy"`
	Label    string  `json:"label,omitempty"`
}

// whereami resolves the CALLER's approximate position from their IP address.
//
// The lookup is keyed on the caller's own IP, so unlike the other two endpoints
// its result is per-user and deliberately NOT shared across an org.
func (s *Server) whereami(w http.ResponseWriter, r *http.Request) {
	// Only Geoapify offers IP geolocation; MapTiler has no equivalent, and an
	// unconfigured deployment has nothing at all.
	if s.mapsCfg.APIKey == "" || (s.mapsCfg.Provider != "geoapify" && s.mapsCfg.Provider != "") {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	ip := mw.ClientIP(r)
	// A private or loopback peer means we are behind an unexpected hop, or this
	// is a dev machine. Either way the provider would answer about our own data
	// centre, which is worse than answering nothing.
	if parsed := net.ParseIP(ip); parsed == nil || !parsed.IsGlobalUnicast() || parsed.IsPrivate() {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	sum := sha256.Sum256([]byte("ip|" + ip))
	key := hex.EncodeToString(sum[:])

	v, err, _ := geoFlight.Do(key, func() (any, error) {
		return s.fetchIPLocation(r.Context(), ip)
	})
	if err != nil {
		s.log.Warn("ip location unavailable", "err", err,
			"request_id", mw.RequestIDFromContext(r.Context()))
		w.WriteHeader(http.StatusNoContent)
		return
	}
	out, ok := v.(whereamiResponse)
	if !ok {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	// Private: this is one user's location, not a shared tile.
	w.Header().Set("Cache-Control", "private, no-store")
	writeJSON(w, http.StatusOK, out)
}

// ── helpers ──────────────────────────────────────────────────────────────────

func writeLabel(w http.ResponseWriter, label string) {
	w.Header().Set("Cache-Control", "public, max-age=86400")
	writeJSON(w, http.StatusOK, map[string]string{"label": label})
}

// cachedLabel reads a previously resolved label out of the blob cache.
func (s *Server) cachedLabel(key string) (string, bool) {
	f, err := s.blobs.CacheGet("geocode", key)
	if err != nil {
		return "", false
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, geocodeMaxSize))
	if err != nil || len(b) == 0 {
		return "", false
	}
	return string(b), true
}

// fetchReverse calls the provider, caches the label and returns it.
func (s *Server) fetchReverse(ctx context.Context, key, lat, lng string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, geocodeTimeout)
	defer cancel()

	var endpoint string
	switch s.mapsCfg.Provider {
	case "geoapify", "":
		endpoint = fmt.Sprintf(
			"https://api.geoapify.com/v1/geocode/reverse?lat=%s&lon=%s&format=json&limit=1&apiKey=%s",
			lat, lng, url.QueryEscape(s.mapsCfg.APIKey))
	case "maptiler":
		endpoint = fmt.Sprintf(
			"https://api.maptiler.com/geocoding/%s,%s.json?limit=1&key=%s",
			lng, lat, url.QueryEscape(s.mapsCfg.APIKey))
	default:
		return "", fmt.Errorf("unknown map provider %q", s.mapsCfg.Provider)
	}

	body, err := s.getJSON(ctx, endpoint)
	if err != nil {
		return "", err
	}

	var label string
	switch s.mapsCfg.Provider {
	case "geoapify", "":
		var parsed struct {
			Results []struct {
				Formatted string `json:"formatted"`
			} `json:"results"`
		}
		if err := json.Unmarshal(body, &parsed); err != nil {
			return "", err
		}
		if len(parsed.Results) > 0 {
			label = parsed.Results[0].Formatted
		}
	case "maptiler":
		var parsed struct {
			Features []struct {
				PlaceName string `json:"place_name"`
			} `json:"features"`
		}
		if err := json.Unmarshal(body, &parsed); err != nil {
			return "", err
		}
		if len(parsed.Features) > 0 {
			label = parsed.Features[0].PlaceName
		}
	}
	if label == "" {
		// A coordinate in the middle of an ocean has no address. Not an error,
		// but nothing worth caching either.
		return "", nil
	}
	// Best-effort: a cache miss next time costs one request, not correctness.
	_ = s.blobs.CachePut("geocode", key, io.LimitReader(strings.NewReader(label), geocodeMaxSize+1), geocodeMaxSize)
	return label, nil
}

// fetchIPLocation asks the provider where an IP address is.
func (s *Server) fetchIPLocation(ctx context.Context, ip string) (whereamiResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, geocodeTimeout)
	defer cancel()

	// url.QueryEscape on the IP as well: it comes from a header, and even
	// though ParseIP has already vetted it, nothing user-influenced should be
	// interpolated into a URL unescaped.
	endpoint := fmt.Sprintf("https://api.geoapify.com/v1/ipinfo?ip=%s&apiKey=%s",
		url.QueryEscape(ip), url.QueryEscape(s.mapsCfg.APIKey))

	body, err := s.getJSON(ctx, endpoint)
	if err != nil {
		return whereamiResponse{}, err
	}
	var parsed struct {
		Location struct {
			Latitude  float64 `json:"latitude"`
			Longitude float64 `json:"longitude"`
		} `json:"location"`
		City struct {
			Name string `json:"name"`
		} `json:"city"`
		Country struct {
			Name string `json:"name"`
		} `json:"country"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return whereamiResponse{}, err
	}
	lat, lng := parsed.Location.Latitude, parsed.Location.Longitude
	// 0,0 is the provider's "I don't know" as much as it is a real coordinate
	// in the Gulf of Guinea; refuse it rather than drop a pin in the ocean.
	if lat == 0 && lng == 0 {
		return whereamiResponse{}, fmt.Errorf("provider returned no location")
	}

	label := parsed.City.Name
	if label != "" && parsed.Country.Name != "" {
		label += ", " + parsed.Country.Name
	} else if label == "" {
		label = parsed.Country.Name
	}

	return whereamiResponse{Lat: lat, Lng: lng, Accuracy: ipAccuracyMeters, Label: label}, nil
}

// getJSON performs one bounded GET and returns the body, refusing anything that
// is not JSON so a provider error page is never parsed as a result.
//
// gosec flags this as G704 (SSRF via taint analysis) because `endpoint`
// traces back to user-influenced values (lat/lng, an IP from a header). Both
// call sites build `endpoint` from a HARDCODED host literal
// (api.geoapify.com / api.maptiler.com) with only query parameters
// interpolated, every one `url.QueryEscape`d — the destination is fixed at
// compile time and never attacker-controlled, so this is not a real SSRF.
func (s *Server) getJSON(ctx context.Context, endpoint string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil) //nolint:gosec // G704: endpoint host is a hardcoded literal, see doc comment above
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req) //nolint:gosec // G704: same fixed-host endpoint, see doc comment above
	if err != nil {
		// http.Client wraps a transport failure (DNS, connect, TLS, timeout) in
		// a *url.Error, whose Error() string embeds the full request URL —
		// including apiKey= — and both callers of getJSON log this error, so
		// the key must not survive past this point.
		return nil, fmt.Errorf("geocode provider request failed: %w", stripRequestURL(err))
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("geocode provider returned %d", resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, geocodeMaxSize))
}

// stripRequestURL removes an *url.Error's embedded request URL — endpoint in
// getJSON, or staticMapURL's return value in maps.go's fetchStaticMap — from
// a transport-level error before it is logged or returned. Both build that
// URL with this server's own provider apiKey in the query string, which
// url.Error otherwise carries verbatim into its Error() string.
func stripRequestURL(err error) error {
	var uerr *url.Error
	if errors.As(err, &uerr) {
		return uerr.Err
	}
	return err
}
