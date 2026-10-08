package store

// B-MSG-8: removing a draft attachment must not unlink a blob that a concurrent
// upload of the same bytes is about to record a row for (and the reverse).
//
// Real Postgres, real overlap — see mail_race_db_test.go's header for why, and
// calls_lifecycle_db_test.go's for the harness (MESSAGING_TEST_DATABASE_URL).

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type blobRaceFixture struct {
	s          *Store
	orgID      string
	author     string
	sha        string
	draftA     string // holds the file being removed
	draftB     string // the concurrent upload's draft
	attachment string // the row on draftA
}

func newBlobRaceFixture(t *testing.T) *blobRaceFixture {
	t.Helper()
	s := lifecycleStore(t)
	ctx := context.Background()
	f := &blobRaceFixture{
		s: s, orgID: uuid.NewString(), author: uuid.NewString(), sha: strings.ReplaceAll(uuid.NewString()+uuid.NewString(), "-", "")[:64],
	}
	seedUser(t, s, f.orgID, f.author, "author", "Author")
	var err error
	if f.draftA, err = s.CreateMailDraft(ctx, f.orgID, f.author); err != nil {
		t.Fatal(err)
	}
	if f.draftB, err = s.CreateMailDraft(ctx, f.orgID, f.author); err != nil {
		t.Fatal(err)
	}
	att, err := s.CreateAttachment(ctx, f.newAttachment(f.draftA, nil))
	if err != nil {
		t.Fatalf("seed attachment: %v", err)
	}
	f.attachment = att.ID
	return f
}

func (f *blobRaceFixture) newAttachment(draftID string, present func() bool) NewAttachment {
	return NewAttachment{
		OrgID: f.orgID, UploaderID: f.author, Scope: ScopeMail, ScopeID: draftID, Role: RoleFile,
		SHA256: f.sha, MIME: "application/pdf", SizeBytes: 10, Filename: "a.pdf",
		StoragePath: f.orgID + "/" + f.sha, TTL: time.Hour, BlobPresent: present,
	}
}

func (f *blobRaceFixture) rowsFor(t *testing.T, draftID string) int {
	t.Helper()
	var n int
	if err := f.s.withBypass(context.Background(), func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(),
			`SELECT count(*) FROM attachments WHERE org_id = $1 AND scope = 'mail' AND scope_id = $2`,
			f.orgID, draftID).Scan(&n)
	}); err != nil {
		t.Fatal(err)
	}
	return n
}

// The removal gets to the blob first: the racing upload, which already wrote
// (deduped onto) the bytes, must be told they are gone instead of recording a
// row that points at a deleted file.
func TestRemoveDraftAttachment_ConcurrentUploadAfterUnlinkIsRefused(t *testing.T) {
	f := newBlobRaceFixture(t)
	ctx := context.Background()

	var blobGone atomic.Bool
	inUnlink, finishUnlink := make(chan struct{}), make(chan struct{})
	removeDone := make(chan error, 1)
	go func() {
		_, err := f.s.RemoveDraftAttachment(ctx, f.orgID, f.author, f.draftA, f.attachment, func(string) {
			close(inUnlink)
			<-finishUnlink // the unlink is "in progress"; the tx is still open
			blobGone.Store(true)
		})
		removeDone <- err
	}()
	<-inUnlink

	uploadDone := make(chan error, 1)
	go func() {
		_, err := f.s.CreateAttachment(ctx, f.newAttachment(f.draftB, func() bool { return !blobGone.Load() }))
		uploadDone <- err
	}()
	waitForBlockedQuery(t, f.s, "%pg_advisory_xact_lock%", finishUnlink)

	if err := <-removeDone; err != nil {
		t.Fatalf("remove: %v", err)
	}
	if err := <-uploadDone; !errors.Is(err, ErrBlobGone) {
		t.Fatalf("racing upload = %v, want ErrBlobGone (a row for a deleted blob must not be recorded)", err)
	}
	if n := f.rowsFor(t, f.draftB); n != 0 {
		t.Fatalf("upload left %d row(s) pointing at the deleted blob", n)
	}
}

// The upload gets there first: the removal must find its row and KEEP the blob.
func TestRemoveDraftAttachment_ConcurrentUploadBeforeUnlinkKeepsTheBlob(t *testing.T) {
	f := newBlobRaceFixture(t)
	ctx := context.Background()

	inUpload, finishUpload := make(chan struct{}), make(chan struct{})
	var once sync.Once
	uploadDone := make(chan error, 1)
	go func() {
		_, err := f.s.CreateAttachment(ctx, f.newAttachment(f.draftB, func() bool {
			once.Do(func() { close(inUpload) })
			<-finishUpload // the upload holds the blob lock, row not yet committed
			return true
		}))
		uploadDone <- err
	}()
	<-inUpload

	var unlinked atomic.Bool
	removeDone := make(chan error, 1)
	go func() {
		_, err := f.s.RemoveDraftAttachment(ctx, f.orgID, f.author, f.draftA, f.attachment,
			func(string) { unlinked.Store(true) })
		removeDone <- err
	}()
	waitForBlockedQuery(t, f.s, "%pg_advisory_xact_lock%", finishUpload)

	if err := <-uploadDone; err != nil {
		t.Fatalf("upload: %v", err)
	}
	if err := <-removeDone; err != nil {
		t.Fatalf("remove: %v", err)
	}
	if unlinked.Load() {
		t.Fatal("removal unlinked a blob the concurrent upload had just recorded a row for")
	}
	if n := f.rowsFor(t, f.draftB); n != 1 {
		t.Fatalf("upload row count = %d, want 1", n)
	}
}

// Without a concurrent reference the blob is unlinked, exactly once.
func TestRemoveDraftAttachment_UnlinksWhenUnreferenced(t *testing.T) {
	f := newBlobRaceFixture(t)
	var got []string
	sha, err := f.s.RemoveDraftAttachment(context.Background(), f.orgID, f.author, f.draftA, f.attachment,
		func(s string) { got = append(got, s) })
	if err != nil {
		t.Fatal(err)
	}
	if sha != f.sha || len(got) != 1 || got[0] != f.sha {
		t.Fatalf("sha=%q unlink calls=%v, want exactly %q", sha, got, f.sha)
	}
}
