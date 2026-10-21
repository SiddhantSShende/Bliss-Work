// Package orgadmins resolves "the current active org_admin ids of an org" by
// calling auth-svc's internal endpoint — auth-svc is the single owner of
// membership/role data (see app/routes/members_service.py's
// _active_admin_ids), so this is a lookup, never a local projection.
//
// Mirrors email-worker's own call into auth-svc (app/relay_consumer.py's
// _lookup_user and app/worker.py's outbox-secret fetch): same base-URL +
// X-Internal-Token convention, same "5xx/network error is transient" posture.
// That client is Python; this is the Go-side equivalent for notification-svc,
// which previously had no outbound HTTP call to another service at all.
package orgadmins

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Lookup resolves the current active org_admin user ids for an org.
type Lookup interface {
	AdminUserIDs(ctx context.Context, orgID string) ([]string, error)
}

// Client calls GET {base}/internal/v1/orgs/{orgID}/admins on auth-svc.
type Client struct {
	base       string
	token      string
	httpClient *http.Client
}

// New builds a Client. base is auth-svc's internal base URL (e.g.
// "http://auth-svc:8001", AUTH_INTERNAL_BASE); token is the shared
// X-Internal-Token secret (AUTH_INTERNAL_TOKEN) — auth-svc's own secret, the
// same one email-worker and telemetry-svc already hold for their own calls
// into auth-svc.
func New(base, token string) *Client {
	return &Client{
		base:  strings.TrimRight(base, "/"),
		token: token,
		httpClient: &http.Client{
			// Bounded like every other internal service-to-service call in
			// this platform (email-worker's _LOOKUP_TIMEOUT, auth-svc's own
			// billing_client.py _TIMEOUT) — this call sits on the critical
			// path of committing a Kafka batch, so it must fail fast rather
			// than hang the consumer.
			Timeout: 5 * time.Second,
		},
	}
}

type adminsResponse struct {
	AdminUserIDs []string `json:"adminUserIds"`
}

// AdminUserIDs returns the org's current active org_admin ids, or an error.
//
// Every failure here — a network error, a non-2xx status, an unparseable
// body — is returned as a plain error, never swallowed into an empty slice.
// The caller (billing.go) must treat that as transient and propagate it
// un-wrapped-as-errMalformed, so the Kafka batch is abandoned uncommitted and
// redelivered rather than silently notifying nobody. Zero admins is not an
// error: it's {"adminUserIds": []} unmarshaled to an empty (non-nil-checked)
// slice, returned with a nil error.
func (c *Client) AdminUserIDs(ctx context.Context, orgID string) ([]string, error) {
	url := fmt.Sprintf("%s/internal/v1/orgs/%s/admins", c.base, orgID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("orgadmins: build request: %w", err)
	}
	req.Header.Set("X-Internal-Token", c.token)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("orgadmins: request org %s admins: %w", orgID, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return nil, fmt.Errorf("orgadmins: org %s admins lookup: status %d: %s", orgID, resp.StatusCode, string(body))
	}

	var parsed adminsResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return nil, fmt.Errorf("orgadmins: decode org %s admins response: %w", orgID, err)
	}
	return parsed.AdminUserIDs, nil
}
