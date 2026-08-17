package blob

import (
	"context"
	"fmt"
)

// Backend names, as accepted by MEDIA_BACKEND.
const (
	BackendFS = "fs"
	BackendS3 = "s3"
)

// Options is the union of what either backend needs, so callers can build one
// value from config and let Open decide.
type Options struct {
	Backend string
	Root    string // fs
	S3      S3Config
}

// Open builds the configured Store, connecting and probing before it returns.
//
// Both backends verify they can actually write at construction — the
// filesystem one with a probe file, the S3 one with a bucket check. That is the
// whole reason this is a constructor rather than lazy initialisation: a
// wrongly-owned volume or a mistyped bucket is a deployment error, and the
// moment to surface it is at boot, in the logs, next to the deploy that caused
// it — not hours later as a 500 in a user's chat.
func Open(ctx context.Context, o Options) (Store, error) {
	switch o.Backend {
	case "", BackendFS:
		return NewFS(o.Root)
	case BackendS3:
		return NewS3(ctx, o.S3)
	default:
		// Unreachable via config.Load, which rejects this first. Kept because
		// this package is also reachable from cmd/gc-attachments and any future
		// tool, and silently defaulting to a disk is the failure mode worth
		// refusing everywhere rather than in one caller.
		return nil, fmt.Errorf("blob: unknown backend %q", o.Backend)
	}
}
