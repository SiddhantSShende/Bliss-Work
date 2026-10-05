package store

// RecordMailAttachmentDownload against a real Postgres with RLS enforcing.
//
// What a Go-only test cannot show, and this one does: that the validation is a
// query over real rows (a thumbnail, a chat-scope row that merely CLAIMS this
// mail's id as its scope_id, another mail's file), that the filename in the
// event is the DECRYPTED stored one, and that what lands in the outbox is
// exactly one well-formed event per call. See calls_lifecycle_db_test.go's
// header for the harness (MESSAGING_TEST_DATABASE_URL, non-superuser role).

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/task-board/messaging-svc/internal/events"
)

// mailWithFile drafts a mail from author, attaches one real (encrypted-filename)
// file to the draft the way the upload endpoint does, then sends it to the
// given recipient. Returns the mail id and the attachment id.
func mailWithFile(t *testing.T, s *Store, orgID, author, toEmail, filename string) (mailID, attID string) {
	t.Helper()
	ctx := context.Background()
	mailID, err := s.CreateMailDraft(ctx, orgID, author)
	if err != nil {
		t.Fatalf("create draft: %v", err)
	}
	att, err := s.CreateAttachment(ctx, NewAttachment{
		OrgID: orgID, UploaderID: author, Scope: ScopeMail, ScopeID: mailID, Role: RoleFile,
		SHA256: "sha-" + uuid.NewString(), MIME: "application/pdf", SizeBytes: 4096,
		Filename: filename, StoragePath: orgID + "/" + uuid.NewString(), TTL: time.Hour,
	})
	if err != nil {
		t.Fatalf("create attachment: %v", err)
	}
	if _, err := s.SendMail(ctx, SendMailInput{
		OrgID: orgID, UserID: author, MailID: mailID,
		To: []string{toEmail}, Subject: "Deck", BodyText: "see attached",
	}); err != nil {
		t.Fatalf("send mail: %v", err)
	}
	return mailID, att.ID
}

// downloadEvents reads back this mail's mail.attachment.downloaded outbox rows,
// oldest first (outbox ids are UUIDv7, so id order is insertion order).
func downloadEvents(t *testing.T, s *Store, mailID string) []events.MailAttachmentDownloaded {
	t.Helper()
	ctx := context.Background()
	var out []events.MailAttachmentDownloaded
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT payload::text FROM outbox
			WHERE kafka_key = $1 AND topic = $2 AND payload->>'type' = $3
			ORDER BY id`,
			mailID, events.TopicMessaging, events.TypeMailAttachmentDownloaded)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var raw string
			if err := rows.Scan(&raw); err != nil {
				return err
			}
			var e events.MailAttachmentDownloaded
			if err := json.Unmarshal([]byte(raw), &e); err != nil {
				return err
			}
			out = append(out, e)
		}
		return rows.Err()
	}); err != nil {
		t.Fatalf("read outbox: %v", err)
	}
	return out
}

type downloadFixture struct {
	s                     *Store
	org                   string
	author, reader, other string // other: same org, not on the mail
	mailID, attID         string
}

func newDownloadFixture(t *testing.T) *downloadFixture {
	t.Helper()
	s := lifecycleStore(t)
	f := &downloadFixture{s: s, org: uuid.NewString(),
		author: uuid.NewString(), reader: uuid.NewString(), other: uuid.NewString()}
	seedMailUser(t, s, f.org, f.author, "author", "Author A", "author@acme.test")
	seedMailUser(t, s, f.org, f.reader, "reader", "Reader R", "reader@acme.test")
	seedMailUser(t, s, f.org, f.other, "other", "Other O", "other@acme.test")
	f.mailID, f.attID = mailWithFile(t, s, f.org, f.author, "reader@acme.test", "Q3 deck.pdf")
	return f
}

func TestRecordMailAttachmentDownload_ReaderWritesOneWellFormedEvent(t *testing.T) {
	f := newDownloadFixture(t)
	if err := f.s.RecordMailAttachmentDownload(context.Background(), f.org, f.reader, f.mailID, f.attID); err != nil {
		t.Fatalf("RecordMailAttachmentDownload: %v", err)
	}
	got := downloadEvents(t, f.s, f.mailID)
	if len(got) != 1 {
		t.Fatalf("events = %d, want exactly 1", len(got))
	}
	e := got[0]
	if e.Type != events.TypeMailAttachmentDownloaded || e.OrgID != f.org || e.ActorID != f.reader ||
		e.MailID != f.mailID || e.AttachmentID != f.attID {
		t.Errorf("event = %+v, want type/org/actor/mail/attachment to be the caller's", e)
	}
	if e.Filename != "Q3 deck.pdf" {
		t.Errorf("filename = %q, want the DECRYPTED stored name %q", e.Filename, "Q3 deck.pdf")
	}
	if e.Mime != "application/pdf" || e.SizeBytes != 4096 {
		t.Errorf("mime/size = %q/%d, want the attachment's own application/pdf/4096", e.Mime, e.SizeBytes)
	}
	if _, err := uuid.Parse(e.EventID); err != nil {
		t.Errorf("eventId %q is not a UUID — telemetry-svc skips events whose id is not one", e.EventID)
	}
	if e.OccurredAt == "" {
		t.Error("occurredAt is empty")
	}
}

// The author's Sent copy is a mail_deliveries row too, so the author may
// download their own attachment and it records, attributed to them.
func TestRecordMailAttachmentDownload_AuthorIsAReaderToo(t *testing.T) {
	f := newDownloadFixture(t)
	if err := f.s.RecordMailAttachmentDownload(context.Background(), f.org, f.author, f.mailID, f.attID); err != nil {
		t.Fatalf("author: %v", err)
	}
	got := downloadEvents(t, f.s, f.mailID)
	if len(got) != 1 || got[0].ActorID != f.author {
		t.Fatalf("events = %+v, want one attributed to the author", got)
	}
}

// Two downloads are two real downloads: the server never collapses them (the
// client is what guards an accidental double-click).
func TestRecordMailAttachmentDownload_EveryCallIsItsOwnEvent(t *testing.T) {
	f := newDownloadFixture(t)
	ctx := context.Background()
	for i := 0; i < 2; i++ {
		if err := f.s.RecordMailAttachmentDownload(ctx, f.org, f.reader, f.mailID, f.attID); err != nil {
			t.Fatalf("call %d: %v", i, err)
		}
	}
	got := downloadEvents(t, f.s, f.mailID)
	if len(got) != 2 {
		t.Fatalf("events = %d, want 2", len(got))
	}
	if got[0].EventID == got[1].EventID {
		t.Errorf("both events share eventId %s — telemetry-svc dedups on it and would drop the second", got[0].EventID)
	}
}

func TestRecordMailAttachmentDownload_NonReaderIsForbiddenAndWritesNothing(t *testing.T) {
	f := newDownloadFixture(t)
	ctx := context.Background()

	// Same org, simply not on the mail.
	err := f.s.RecordMailAttachmentDownload(ctx, f.org, f.other, f.mailID, f.attID)
	if !errors.Is(err, ErrForbidden) {
		t.Errorf("same-org non-reader: err = %v, want ErrForbidden", err)
	}

	// A member of another org, naming this org's ids, in either org's context.
	org2, outsider := uuid.NewString(), uuid.NewString()
	seedMailUser(t, f.s, org2, outsider, "outsider", "Out S", "out@other.test")
	for _, org := range []string{org2, f.org} {
		err := f.s.RecordMailAttachmentDownload(ctx, org, outsider, f.mailID, f.attID)
		if !errors.Is(err, ErrForbidden) && !errors.Is(err, ErrNotFound) {
			t.Errorf("cross-org (as org %s): err = %v, want a refusal", org, err)
		}
	}

	if n := len(downloadEvents(t, f.s, f.mailID)); n != 0 {
		t.Errorf("a refused call wrote %d event(s), want 0", n)
	}
}

// Membership is checked BEFORE the attachment is looked up, so a non-reader
// gets the same ErrForbidden whether or not the pair is real — they cannot use
// this route to learn that attachment X belongs to mail Y.
func TestRecordMailAttachmentDownload_NonReaderGetsNoPairOracle(t *testing.T) {
	f := newDownloadFixture(t)
	ctx := context.Background()
	_, otherMailsAtt := mailWithFile(t, f.s, f.org, f.author, "reader@acme.test", "Other.pdf")

	realPair := f.s.RecordMailAttachmentDownload(ctx, f.org, f.other, f.mailID, f.attID)
	wrongPair := f.s.RecordMailAttachmentDownload(ctx, f.org, f.other, f.mailID, otherMailsAtt)
	bogusID := f.s.RecordMailAttachmentDownload(ctx, f.org, f.other, f.mailID, uuid.NewString())
	for name, err := range map[string]error{"real pair": realPair, "wrong pair": wrongPair, "unknown id": bogusID} {
		if !errors.Is(err, ErrForbidden) {
			t.Errorf("non-reader, %s: err = %v, want ErrForbidden for all three alike", name, err)
		}
	}
}

func TestRecordMailAttachmentDownload_AttachmentMustBelongToThisMail(t *testing.T) {
	f := newDownloadFixture(t)
	ctx := context.Background()
	// The reader may read BOTH mails; the file just is not on f.mailID.
	otherMail, otherAtt := mailWithFile(t, f.s, f.org, f.author, "reader@acme.test", "Other.pdf")

	if err := f.s.RecordMailAttachmentDownload(ctx, f.org, f.reader, f.mailID, otherAtt); !errors.Is(err, ErrNotFound) {
		t.Errorf("another mail's file under this mail id: err = %v, want ErrNotFound", err)
	}
	if err := f.s.RecordMailAttachmentDownload(ctx, f.org, f.reader, f.mailID, uuid.NewString()); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown attachment id: err = %v, want ErrNotFound", err)
	}
	for _, id := range []string{f.mailID, otherMail} {
		if n := len(downloadEvents(t, f.s, id)); n != 0 {
			t.Errorf("mail %s has %d download event(s) after only refused calls, want 0", id, n)
		}
	}
}

// Malformed ids never reach SQL (a uuid cast would be a 500, not a 404).
func TestRecordMailAttachmentDownload_MalformedIDsAreNotFound(t *testing.T) {
	f := newDownloadFixture(t)
	ctx := context.Background()
	if err := f.s.RecordMailAttachmentDownload(ctx, f.org, f.reader, "not-a-uuid", f.attID); !errors.Is(err, ErrNotFound) {
		t.Errorf("malformed mail id: err = %v, want ErrNotFound", err)
	}
	if err := f.s.RecordMailAttachmentDownload(ctx, f.org, f.reader, f.mailID, "not-a-uuid"); !errors.Is(err, ErrNotFound) {
		t.Errorf("malformed attachment id: err = %v, want ErrNotFound", err)
	}
}

func TestRecordMailAttachmentDownload_ThumbnailIsRejected(t *testing.T) {
	f := newDownloadFixture(t)
	ctx := context.Background()
	// A client-generated poster hanging off the real file, same mail scope. It
	// is a rendering detail of its parent, never a downloadable attachment.
	thumb, err := f.s.CreateAttachment(ctx, NewAttachment{
		OrgID: f.org, UploaderID: f.author, Scope: ScopeMail, ScopeID: f.mailID, Role: RoleThumb,
		ParentID: f.attID, SHA256: "sha-" + uuid.NewString(), MIME: "image/jpeg", SizeBytes: 10,
		Filename: "poster.jpg", StoragePath: f.org + "/" + uuid.NewString(), TTL: time.Hour,
	})
	if err != nil {
		t.Fatalf("create thumb: %v", err)
	}
	if err := f.s.RecordMailAttachmentDownload(ctx, f.org, f.reader, f.mailID, thumb.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("thumbnail: err = %v, want ErrNotFound", err)
	}
	if n := len(downloadEvents(t, f.s, f.mailID)); n != 0 {
		t.Errorf("a thumbnail wrote %d event(s), want 0", n)
	}
}

// A row of the wrong scope that merely carries this mail's id as its scope_id
// must not pass: the scope column is checked, not just the id.
func TestRecordMailAttachmentDownload_WrongScopeIsRejected(t *testing.T) {
	f := newDownloadFixture(t)
	ctx := context.Background()
	forged := uuid.NewString()
	if err := f.s.withBypass(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			INSERT INTO attachments
			  (id, org_id, uploader_id, scope, scope_id, role, filename, sha256, mime, size_bytes, storage_path)
			VALUES ($1, $2, $3, 'conversation', $4, 'file', 'chat.pdf', $5, 'application/pdf', 1, $6)`,
			forged, f.org, f.author, f.mailID, "sha-"+forged, f.org+"/"+forged)
		return err
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := f.s.RecordMailAttachmentDownload(ctx, f.org, f.reader, f.mailID, forged); !errors.Is(err, ErrNotFound) {
		t.Errorf("conversation-scope row under a mail id: err = %v, want ErrNotFound", err)
	}
	if n := len(downloadEvents(t, f.s, f.mailID)); n != 0 {
		t.Errorf("wrong-scope row wrote %d event(s), want 0", n)
	}
}
