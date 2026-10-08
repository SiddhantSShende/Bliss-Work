package blob

import (
	"io"
	"path"
	"regexp"
	"time"

	"github.com/google/uuid"
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

	// OpenKey returns a seekable handle on a key this package produced —
	// today, RecordingKey.
	//
	// Every other read here is content-addressed: the caller has a sha and the
	// layout is derived from it. A call recording is not written by this
	// service at all (LiveKit Egress writes it), so its key is agreed up front
	// instead of discovered afterwards, and reading it back needs a way in that
	// takes the key. Implementations MUST re-validate the key rather than
	// trusting the caller's — it is the whole path-traversal boundary for this
	// route.
	OpenKey(key string) (Reader, error)

	// PutDerived / OpenDerived hold a SERVER-generated derivative of one stored
	// attachment blob — today, the converted preview of an Office file (a PDF,
	// or the JSON of a spreadsheet's cell text).
	//
	// A derivative is user content, so unlike CachePut it IS org-scoped: it is
	// stored beside its original (`blobs/{org}/ab/cd/{sha}.v1.pdf`). That one
	// placement is what makes Remove (the attachment reaper) and RemoveOrg
	// (org erasure) take it along with no extra bookkeeping.
	//
	// `variant` comes from a closed set (see ValidVariant). PutDerived is atomic:
	// a derivative is either complete or absent, never partial. It returns
	// ErrTooLarge, storing nothing, when r yields more than max bytes.
	PutDerived(orgID, sha, variant string, r io.Reader, max int64) error
	OpenDerived(orgID, sha, variant string) (Reader, error)
}

// variantRe is the closed set of derivative names: a converter-version tag and
// one of the artifact extensions. Bumping the tag (v1 → v2) when the converter
// changes invalidates every cached derivative without deleting anything.
var variantRe = regexp.MustCompile(`^v[0-9]{1,3}\.(pdf|json)$`)

// ValidVariant reports whether v names an allowed derivative.
func ValidVariant(v string) bool { return variantRe.MatchString(v) }

// RecordingKey is where a call's recording is written and read back.
//
// Under `blobs/{orgID}/` deliberately, and not a sibling tree: RemoveOrg is a
// single prefix removal under exactly that path, so an org erasure takes its
// recordings with it. A recordings/ tree of its own would have been quietly
// missed by the one operation that must not miss anything.
//
// `ext` is the container the SFU was asked to write ("mp4", "ogg"), which is
// also the only part of this key that is not a UUID.
func RecordingKey(orgID, callID, egressID, ext string) (string, error) {
	if _, err := uuid.Parse(orgID); err != nil {
		return "", ErrBadKey
	}
	if _, err := uuid.Parse(callID); err != nil {
		return "", ErrBadKey
	}
	if !egressIDRe.MatchString(egressID) || !extRe.MatchString(ext) {
		return "", ErrBadKey
	}
	return path.Join("blobs", orgID, "recordings", callID, egressID+"."+ext), nil
}

// ParseRecordingKey re-validates a key read back out of the database.
//
// A stored key is not automatically trustworthy: it becomes a filesystem path
// on the fs backend, and "the database only ever holds keys we wrote" is a
// property of today's code, not of the bytes on disk. So the same shape is
// required on the way out as on the way in.
func ParseRecordingKey(key string) error {
	if !recordingKeyRe.MatchString(key) {
		return ErrBadKey
	}
	return nil
}

var (
	// LiveKit egress ids look like "EG_xxxxxxxxxxxx". Anchored and
	// conservative: this becomes a filename.
	egressIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	extRe      = regexp.MustCompile(`^[a-z0-9]{2,5}$`)
	// The whole key, exactly as RecordingKey builds it. No separators beyond
	// the four it names, no "..", no absolute path can satisfy it.
	recordingKeyRe = regexp.MustCompile(
		`^blobs/[0-9a-fA-F-]{36}/recordings/[0-9a-fA-F-]{36}/[A-Za-z0-9_-]{1,64}\.[a-z0-9]{2,5}$`)
)

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
