// Package pins talks to sticky-svc's internal API.
//
// One call: "give me open pins nobody has confirmed receiving". That endpoint
// CLAIMS the rows it returns (it increments delivery_attempts in the same
// statement), which is what stops two replicas of this service nudging the same
// person twice — so this client must treat a successful response as work it now
// owns, and must not retry a request whose response it merely failed to read.
package pins

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/task-board/sticky-relay/internal/sweep"
)

// Every call is bounded. An unbounded request to a dependency is how a sweep
// loop stops sweeping without anyone noticing.
const defaultTimeout = 10 * time.Second

// Cap on the response body we will read, so a misbehaving or compromised
// upstream cannot exhaust this process's memory.
const maxBodyBytes = 8 << 20 // 8 MiB

type Client struct {
	baseURL string
	token   string
	http    *http.Client
}

func New(baseURL, token string) *Client {
	return &Client{
		baseURL: baseURL,
		token:   token,
		http:    &http.Client{Timeout: defaultTimeout},
	}
}

// wirePin mirrors sticky-svc's UndeliveredPinDTO.
type wirePin struct {
	TaskID           string `json:"taskId"`
	OrgID            string `json:"orgId"`
	AssigneeID       string `json:"assigneeId"`
	OpenedAt         string `json:"openedAt"`
	DeliveryAttempts int    `json:"deliveryAttempts"`
}

// Undelivered fetches one page of open, never-confirmed pins older than
// olderThan. The returned rows are already claimed upstream.
func (c *Client) Undelivered(ctx context.Context, olderThan time.Duration, limit int) ([]sweep.Pin, error) {
	q := url.Values{}
	q.Set("older_than_s", strconv.Itoa(int(olderThan.Seconds())))
	q.Set("limit", strconv.Itoa(limit))

	endpoint := c.baseURL + "/internal/pins/undelivered?" + q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("X-Internal-Token", c.token)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch undelivered pins: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		// Read a little of the body for the log, then discard — the message is
		// diagnostic, and an error body is not a place to trust a length.
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("sticky-svc returned %d: %s", resp.StatusCode, snippet)
	}

	var wire []wirePin
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxBodyBytes)).Decode(&wire); err != nil {
		return nil, fmt.Errorf("decode undelivered pins: %w", err)
	}

	out := make([]sweep.Pin, 0, len(wire))
	for _, w := range wire {
		openedAt, err := time.Parse(time.RFC3339, w.OpenedAt)
		if err != nil {
			// One unparseable row must not discard the whole page: the rows are
			// already claimed, so dropping the page would silently spend an
			// attempt for every pin in it.
			continue
		}
		out = append(out, sweep.Pin{
			TaskID:           w.TaskID,
			OrgID:            w.OrgID,
			AssigneeID:       w.AssigneeID,
			OpenedAt:         openedAt,
			DeliveryAttempts: w.DeliveryAttempts,
		})
	}
	return out, nil
}
