package blob

import (
	"io"
	"time"
)

// Store is where attachment bytes live.
//
// Two implementations: the local filesystem (fs.go, the historical and still
// default one) and any S3-compatible object store (s3.go — MinIO, S3, R2,
// Spaces). The interface exists for one concrete reason rather than as
// architecture-for-its-own-sake: local disk is what pins messaging-svc to a
// single replica. Two pods do not share a volume, so pod A accepts an upload
// and pod B 404s the download, per request, at random.
//
// The layout contract is IDENTICAL across implementations — `blobs/{orgID}/…`,
// sharded by org — because it is load-bearing in two ways that outlive the
// storage choice:
//
//   - A globally content-addressed store is a content-confirmation oracle:
//     upload bytes you merely SUSPECT another org holds, observe the write
//     dedupe, and you have confirmed it. Sharding by org kills that.
//   - "Delete everything for org X" stays one prefix removal, which is what
//     RemoveOrg needs for org deletion.
//
// Callers never see which implementation they hold. `RelPath` is stored in
// `attachments.storage_path` and is relative to the root/prefix precisely so
// the root can move — including from a disk to a bucket — without rewriting a
// single database row.
type Store interface {
	// WriteStream streams r, hashing as it goes, and returns the content
	// address. Never buffers the payload in memory. Returns ErrTooLarge if r
	// yields more than max bytes.
	WriteStream(orgID string, r io.Reader, max int64) (sha string, n int64, err error)

	// Open returns a seekable handle. Seekable is required, not incidental:
	// http.ServeContent needs it for Range requests, which is what makes video
	// scrubbing work.
	Open(orgID, sha string) (Reader, error)

	// Remove deletes one blob. A missing blob is NOT an error — "already gone"
	// is the desired end state for the attachment reaper.
	Remove(orgID, sha string) error

	// RemoveOrg deletes every blob for one organization. The only thing that
	// reaches attachment bytes on org deletion: they are not application-layer
	// encrypted, so the crypto-shred does nothing for them.
	RemoveOrg(orgID string) error

	// RelPath is the value stored in attachments.storage_path.
	RelPath(orgID, sha string) (string, error)

	// CacheGet / CachePut hold SERVER-derived content (static maps, reverse
	// geocodes). The key is a hash the server computes from validated numeric
	// parameters, so unlike user uploads it needs no org scoping and cannot be
	// steered by a client.
	CacheGet(kind, key string) (Reader, error)
	CachePut(kind, key string, r io.Reader, max int64) error
}

// Reader is an open handle plus the two facts http.ServeContent wants.
//
// Deliberately not *os.File: that type is exactly what a bucket cannot return,
// and it was the only thing in the old signature tying this package to a disk.
// minio-go's Object satisfies ReadSeekCloser natively, so both implementations
// give real Range support rather than one of them faking it by buffering.
type Reader interface {
	io.ReadSeekCloser
	Size() int64
	ModTime() time.Time
}
