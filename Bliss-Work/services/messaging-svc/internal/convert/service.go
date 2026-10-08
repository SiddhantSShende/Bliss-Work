package convert

import (
	"context"
	"errors"
	"io"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"

	"github.com/task-board/messaging-svc/internal/blob"
	"github.com/task-board/messaging-svc/internal/media"
)

// Config holds the Service's limits. Every default belongs to config.Load; the
// values are provisional until the measurement run (plan §3.3) sets them.
type Config struct {
	Wait         time.Duration // how long a request waits for a conversion before answering "pending"
	RunTimeout   time.Duration // the whole conversion, including waiting for a free slot
	MaxOutput    int64         // largest derived artifact stored
	MaxSheets    int64         // largest sheets JSON accepted from the sandbox
	MaxInFlight  int           // conversions this replica sends to the sandbox at once
	FailureTTL   time.Duration // how long a deterministic failure is remembered
	FailureLimit int           // most failures remembered at once
	BusyRetry    time.Duration // pause before asking a busy sandbox again (default 1s)
}

// Service turns "this attachment has no preview yet" into "it has one", once,
// no matter how many requests ask meanwhile.
type Service struct {
	blobs  blob.Store
	client *Client
	cfg    Config
	group  singleflight.Group
	sem    chan struct{}

	mu    sync.Mutex
	fails map[string]failure
}

type failure struct {
	err   error
	until time.Time
}

// NewService builds the orchestrator.
func NewService(blobs blob.Store, client *Client, cfg Config) *Service {
	if cfg.MaxInFlight < 1 {
		cfg.MaxInFlight = 1
	}
	if cfg.FailureLimit < 1 {
		cfg.FailureLimit = 1024
	}
	if cfg.BusyRetry <= 0 {
		cfg.BusyRetry = time.Second
	}
	return &Service{
		blobs: blobs, client: client, cfg: cfg,
		sem: make(chan struct{}, cfg.MaxInFlight), fails: map[string]failure{},
	}
}

// Ready reports whether a derivative already exists. It is a cheap probe and
// deliberately says nothing about whether the caller may see it: authorization
// is the handler's job and happens before this is ever asked.
func (s *Service) Ready(orgID, sha string, spec media.PreviewSpec) bool {
	r, err := s.blobs.OpenDerived(orgID, sha, spec.Variant)
	if err != nil {
		return false
	}
	_ = r.Close()
	return true
}

// Remembered returns a still-fresh deterministic failure for this document.
func (s *Service) Remembered(orgID, sha string, spec media.PreviewSpec) error {
	key := cacheKey(orgID, sha, spec)
	s.mu.Lock()
	defer s.mu.Unlock()
	f, ok := s.fails[key]
	if !ok {
		return nil
	}
	if time.Now().After(f.until) {
		delete(s.fails, key)
		return nil
	}
	return f.err
}

// Ensure makes sure a derivative exists, converting if it must.
//
// It returns (true, nil) when one exists. It returns (false, nil) when the
// conversion is still running after cfg.Wait: the work CONTINUES in the
// background (it never depends on the caller's context) and the caller is meant
// to ask again. Concurrent callers for the same document share one conversion.
func (s *Service) Ensure(ctx context.Context, orgID, sha string, spec media.PreviewSpec) (bool, error) {
	if s.Ready(orgID, sha, spec) {
		return true, nil
	}
	if err := s.Remembered(orgID, sha, spec); err != nil {
		return false, err
	}
	key := cacheKey(orgID, sha, spec)
	ch := s.group.DoChan(key, func() (any, error) {
		runCtx, cancel := context.WithTimeout(context.Background(), s.cfg.RunTimeout)
		defer cancel()
		err := s.run(runCtx, orgID, sha, spec)
		if err != nil && Deterministic(err) {
			s.remember(key, err)
		}
		return nil, err
	})
	wait := time.NewTimer(s.cfg.Wait)
	defer wait.Stop()
	select {
	case res := <-ch:
		if res.Err != nil {
			return false, res.Err
		}
		return true, nil
	case <-wait.C:
		return false, nil
	case <-ctx.Done():
		return false, ctx.Err()
	}
}

func (s *Service) run(ctx context.Context, orgID, sha string, spec media.PreviewSpec) error {
	select {
	case s.sem <- struct{}{}:
		defer func() { <-s.sem }()
	case <-ctx.Done():
		return ErrBusy
	}
	// A busy sandbox is a queue, not a failure. This replica caps its own in-flight
	// conversions, but several replicas share one sandbox, so it can still answer
	// "busy". Asking again (the request has long since been told "pending" and is
	// polling) turns that into waiting; only a sandbox that stays busy for the whole
	// run budget ends as ErrBusy.
	sawBusy := false
	for {
		err := s.convertOnce(ctx, orgID, sha, spec)
		switch {
		case err == nil:
			return nil
		case errors.Is(err, ErrBusy):
			sawBusy = true
		case sawBusy && ctx.Err() != nil:
			// The budget ran out while queueing (cutting an attempt short): that is the
			// sandbox being busy, not something wrong with the document, and it must not
			// be remembered against it.
			return ErrBusy
		default:
			return err
		}
		select {
		case <-time.After(s.cfg.BusyRetry):
		case <-ctx.Done():
			return ErrBusy
		}
	}
}

func (s *Service) convertOnce(ctx context.Context, orgID, sha string, spec media.PreviewSpec) error {
	f, err := s.blobs.Open(orgID, sha)
	if err != nil {
		return ErrUnavailable
	}
	defer f.Close()

	err = s.client.Convert(ctx, spec, f, f.Size(), s.cfg.MaxSheets, func(r io.Reader) error {
		return s.blobs.PutDerived(orgID, sha, spec.Variant, r, s.cfg.MaxOutput)
	})
	if errors.Is(err, blob.ErrTooLarge) {
		return ErrLimit
	}
	return err
}

func (s *Service) remember(key string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.fails) >= s.cfg.FailureLimit {
		now := time.Now()
		for k, f := range s.fails {
			if now.After(f.until) {
				delete(s.fails, k)
			}
		}
		for k := range s.fails { // still full: make room by dropping one entry
			delete(s.fails, k)
			break
		}
	}
	s.fails[key] = failure{err: err, until: time.Now().Add(s.cfg.FailureTTL)}
}

func cacheKey(orgID, sha string, spec media.PreviewSpec) string {
	return orgID + "/" + sha + "/" + spec.Variant
}
