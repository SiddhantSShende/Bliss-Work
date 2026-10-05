package api

// POST /api/v1/mail/{id}/attachments/{attachmentId}/downloaded through the REAL
// router: the real JWT middleware, handler, store and Postgres with RLS
// enforcing. What this adds over the store-level test is the HTTP contract —
// that the actor is the verified token's and nothing the request says can name
// someone else, and the status codes for each refusal.
//
// Opt-in via MESSAGING_API_TEST_DATABASE_URL (a non-superuser role); see
// meeting_series_http_db_test.go's header.

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/task-board/messaging-svc/internal/store"
)

type mailDownloadFixture struct {
	*httpFixture
	mailID, attID string
}

// newMailDownloadFixture sends a mail from f.ada to f.grace with one file
// attached. f.host is in the org but not on the mail; f.stranger is in another
// org.
func newMailDownloadFixture(t *testing.T) *mailDownloadFixture {
	t.Helper()
	f := newHTTPFixture(t)
	f.exec(`UPDATE user_projection SET email = $2 WHERE user_id = $1`, f.ada, "ada-"+f.org[:8]+"@acme.test")
	f.exec(`UPDATE user_projection SET email = $2 WHERE user_id = $1`, f.grace, "grace-"+f.org[:8]+"@acme.test")
	return sendMailWithFile(t, f, "photo.png", "image/png")
}

// sendMailWithFile sends an ada→grace mail with one file attached, through the
// same store calls the upload and send endpoints use.
func sendMailWithFile(t *testing.T, f *httpFixture, filename, mime string) *mailDownloadFixture {
	t.Helper()
	ctx := context.Background()
	mailID, err := f.srv.store.CreateMailDraft(ctx, f.org, f.ada)
	if err != nil {
		t.Fatalf("create draft: %v", err)
	}
	att, err := f.srv.store.CreateAttachment(ctx, store.NewAttachment{
		OrgID: f.org, UploaderID: f.ada, Scope: store.ScopeMail, ScopeID: mailID, Role: store.RoleFile,
		SHA256: "sha-" + uuid.NewString(), MIME: mime, SizeBytes: 2048,
		Filename: filename, StoragePath: f.org + "/" + uuid.NewString(), TTL: time.Hour,
	})
	if err != nil {
		t.Fatalf("create attachment: %v", err)
	}
	if _, err := f.srv.store.SendMail(ctx, store.SendMailInput{
		OrgID: f.org, UserID: f.ada, MailID: mailID,
		To: []string{"grace-" + f.org[:8] + "@acme.test"}, Subject: filename, BodyText: "see attached",
	}); err != nil {
		t.Fatalf("send mail: %v", err)
	}
	return &mailDownloadFixture{httpFixture: f, mailID: mailID, attID: att.ID}
}

func (f *mailDownloadFixture) path(mailID, attID string) string {
	return "/api/v1/mail/" + mailID + "/attachments/" + attID + "/downloaded"
}

// downloadEventsBy counts this mail's download events attributed to actor.
func (f *mailDownloadFixture) downloadEventsBy(actor string) int {
	return f.count(`SELECT count(*) FROM outbox
		WHERE payload->>'type' = 'mail.attachment.downloaded'
		  AND payload->>'mailId' = $1 AND payload->>'actorId' = $2`, f.mailID, actor)
}

func (f *mailDownloadFixture) downloadEventsTotal() int {
	return f.count(`SELECT count(*) FROM outbox
		WHERE payload->>'type' = 'mail.attachment.downloaded' AND payload->>'mailId' = $1`, f.mailID)
}

func TestMailAttachmentDownloadHTTP_ReaderRecordsAsThemselves(t *testing.T) {
	f := newMailDownloadFixture(t)

	code, body := f.as(f.grace, f.org)("POST", f.path(f.mailID, f.attID), nil)
	if code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204 (body: %s)", code, body)
	}
	if n := f.downloadEventsBy(f.grace); n != 1 {
		t.Errorf("events attributed to the authenticated reader = %d, want 1", n)
	}
	if n := f.downloadEventsTotal(); n != 1 {
		t.Errorf("total events = %d, want 1", n)
	}
}

// Nothing in the request can name another user: the body is ignored and a
// userId/actorId in the query string or JSON is not read at all. The row is
// attributed to the token's subject regardless.
func TestMailAttachmentDownloadHTTP_ActorComesFromTheTokenNotTheRequest(t *testing.T) {
	f := newMailDownloadFixture(t)

	spoof := map[string]any{"actorId": f.ada, "userId": f.ada, "orgId": f.other}
	code, body := f.as(f.grace, f.org)("POST", f.path(f.mailID, f.attID)+"?userId="+f.ada+"&actorId="+f.ada, spoof)
	if code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204 (body: %s)", code, body)
	}
	if n := f.downloadEventsBy(f.ada); n != 0 {
		t.Errorf("events attributed to the spoofed user = %d, want 0", n)
	}
	if n := f.downloadEventsBy(f.grace); n != 1 {
		t.Errorf("events attributed to the token's user = %d, want 1", n)
	}
	if n := f.count(`SELECT count(*) FROM outbox
		WHERE payload->>'type' = 'mail.attachment.downloaded' AND payload->>'mailId' = $1
		  AND payload->>'orgId' = $2`, f.mailID, f.org); n != 1 {
		t.Errorf("events carrying the token's org = %d, want 1", n)
	}
}

func TestMailAttachmentDownloadHTTP_AuthorCanRecordTheirOwnSentFile(t *testing.T) {
	f := newMailDownloadFixture(t)
	if code, body := f.as(f.ada, f.org)("POST", f.path(f.mailID, f.attID), nil); code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204 (body: %s)", code, body)
	}
	if n := f.downloadEventsBy(f.ada); n != 1 {
		t.Errorf("events attributed to the author = %d, want 1", n)
	}
}

func TestMailAttachmentDownloadHTTP_RequiresAuthentication(t *testing.T) {
	f := newMailDownloadFixture(t)
	if code, _ := f.do("POST", f.path(f.mailID, f.attID), "", nil); code != http.StatusUnauthorized {
		t.Errorf("no token: status = %d, want 401", code)
	}
	if code, _ := f.do("POST", f.path(f.mailID, f.attID), "not.a.jwt", nil); code != http.StatusUnauthorized {
		t.Errorf("garbage token: status = %d, want 401", code)
	}
	if n := f.downloadEventsTotal(); n != 0 {
		t.Errorf("unauthenticated calls wrote %d event(s), want 0", n)
	}
}

func TestMailAttachmentDownloadHTTP_NonReaderIsForbidden(t *testing.T) {
	f := newMailDownloadFixture(t)
	// Same org, not on the mail.
	if code, _ := f.as(f.host, f.org)("POST", f.path(f.mailID, f.attID), nil); code != http.StatusForbidden {
		t.Errorf("same-org non-reader: status = %d, want 403", code)
	}
	// Another org entirely, with a perfectly valid token of their own.
	if code, _ := f.as(f.stranger, f.other)("POST", f.path(f.mailID, f.attID), nil); code != http.StatusForbidden && code != http.StatusNotFound {
		t.Errorf("other-org user: status = %d, want 403 (or 404)", code)
	}
	if n := f.downloadEventsTotal(); n != 0 {
		t.Errorf("refused calls wrote %d event(s), want 0", n)
	}
}

func TestMailAttachmentDownloadHTTP_OwnershipAndKindValidation(t *testing.T) {
	f := newMailDownloadFixture(t)
	ctx := context.Background()
	asGrace := f.as(f.grace, f.org)

	// A thumbnail of the real file, in the same mail scope.
	thumb, err := f.srv.store.CreateAttachment(ctx, store.NewAttachment{
		OrgID: f.org, UploaderID: f.ada, Scope: store.ScopeMail, ScopeID: f.mailID, Role: store.RoleThumb,
		ParentID: f.attID, SHA256: "sha-" + uuid.NewString(), MIME: "image/jpeg", SizeBytes: 10,
		Filename: "poster.jpg", StoragePath: f.org + "/" + uuid.NewString(), TTL: time.Hour,
	})
	if err != nil {
		t.Fatalf("create thumb: %v", err)
	}
	// A real mail-scope file of a DIFFERENT mail grace can also read.
	otherMail := sendMailWithFile(t, f.httpFixture, "second.pdf", "application/pdf")

	cases := []struct {
		name, path string
		want       int
	}{
		{"thumbnail", f.path(f.mailID, thumb.ID), http.StatusNotFound},
		{"another mail's file", f.path(f.mailID, otherMail.attID), http.StatusNotFound},
		{"unknown attachment", f.path(f.mailID, uuid.NewString()), http.StatusNotFound},
		{"malformed mail id", f.path("nope", f.attID), http.StatusBadRequest},
		{"malformed attachment id", f.path(f.mailID, "nope"), http.StatusBadRequest},
	}
	for _, c := range cases {
		if code, body := asGrace("POST", c.path, nil); code != c.want {
			t.Errorf("%s: status = %d, want %d (body: %s)", c.name, code, c.want, body)
		}
	}
	if n := f.downloadEventsTotal(); n != 0 {
		t.Errorf("refused calls wrote %d event(s) on this mail, want 0", n)
	}
}

// Two presses are two events — the server does not collapse them.
func TestMailAttachmentDownloadHTTP_SeparateDownloadsAreEachRecorded(t *testing.T) {
	f := newMailDownloadFixture(t)
	asGrace := f.as(f.grace, f.org)
	for i := 0; i < 2; i++ {
		if code, body := asGrace("POST", f.path(f.mailID, f.attID), nil); code != http.StatusNoContent {
			t.Fatalf("call %d: status = %d, want 204 (body: %s)", i, code, body)
		}
	}
	if n := f.downloadEventsBy(f.grace); n != 2 {
		t.Errorf("events = %d, want 2", n)
	}
	if n := f.count(`SELECT count(DISTINCT payload->>'eventId') FROM outbox
		WHERE payload->>'type' = 'mail.attachment.downloaded' AND payload->>'mailId' = $1`, f.mailID); n != 2 {
		t.Errorf("distinct eventIds = %d, want 2", n)
	}
}
