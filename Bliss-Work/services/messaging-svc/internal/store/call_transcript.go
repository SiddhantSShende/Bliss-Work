package store

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// The transcript of a meeting: what was said in its chat, and the points its
// participants wrote down.
//
// Both used to exist only on the SFU's data channel and in each participant's
// own localStorage — see migration 0029 for what that cost. The data channel is
// still what makes them appear instantly for everybody in the room; this is
// what makes them outlive it.
//
// ── The shape of every method here ───────────────────────────────────────────
// Two transactions, always, and the split is deliberate:
//
//	1. AUTHORIZE, under the caller's own RLS context (withCaller). Reading the
//	   call row IS the read authorization — the calls policy already means "my
//	   org's call, or one I am on the roster of" — and a write additionally
//	   joins call_participants, so writing needs to have actually been there.
//	2. ACT, under bypass, and ONLY the ciphertext work plus the row itself.
//
// The bypass is not a convenience. A meeting's transcript is encrypted under
// the HOSTING org's DEK (that is who the meeting belongs to; a guest's line has
// to stay readable by the host), and org_keys is org-isolated by RLS — so a
// cross-org guest's own RLS context cannot reach the key that their own message
// must be sealed with, nor the one that unseals what they are entitled to read.
// Step 1 has already decided the question bypass would otherwise answer, which
// is the same argument CallForNotify makes for its own.
//
// The RLS policy on both tables stays as written and stays enforcing: it is the
// wall in front of any path that does NOT bypass, and it is what makes "an org
// admin who was not in the meeting cannot insert a line into its transcript"
// true of the database rather than only of this file.

// CallChatDTO is one message from a meeting's chat, addressed to the room.
//
// Directed ("private") messages are NOT here and never will be: the SFU
// delivers those to one participant and nobody else, and storing them would
// widen an audience the sender chose. See migration 0029.
type CallChatDTO struct {
	ID       string `json:"id"`
	CallID   string `json:"callId"`
	SenderID string `json:"senderId"`
	Text     string `json:"text"`
	SentAt   string `json:"sentAt"`
}

// CallNoteDTO is one point somebody wrote down during a meeting.
type CallNoteDTO struct {
	ID        string `json:"id"`
	CallID    string `json:"callId"`
	AuthorID  string `json:"authorId"`
	Text      string `json:"text"`
	WrittenAt string `json:"writtenAt"`
}

// CallChatPageDTO / CallNotePageDTO mirror InboxPageDTO: a page plus the cursor
// that continues it, or nil when there is nothing after this.
type CallChatPageDTO struct {
	Items      []CallChatDTO `json:"items"`
	NextCursor *string       `json:"nextCursor"`
}

type CallNotePageDTO struct {
	Items      []CallNoteDTO `json:"items"`
	NextCursor *string       `json:"nextCursor"`
}

// Longest single entry, matching the client's CHAT_TEXT_MAX / NOTE_TEXT_MAX.
// Enforced here as well because a limit only the sender's browser applies is
// not a limit. Bytes, like every other length check in this package (see
// normalizeTranscriptText) — Go's len() on a string already counts bytes,
// which is what makes this the actual storage cost rather than a character
// count that disagrees with it on non-Latin text.
const CallTranscriptTextMax = 500

// Errors specific to one chat/note request being malformed on its own terms —
// as opposed to ErrForbidden, which means the caller was not entitled to make
// it at all. Kept distinct so mapStoreError can tell a client that typed too
// much apart from a client that may not write here — the same reasoning as
// mail.go's ErrMailSubjectTooLong / ErrMailBodyTooLong.
var (
	ErrTranscriptTextInvalid    = fmt.Errorf("text must be 1 to %d bytes", CallTranscriptTextMax)
	ErrTranscriptEntryIDInvalid = errors.New("entry id is too long")
	ErrTranscriptCursorInvalid  = errors.New("invalid pagination cursor")
)

// DefaultTranscriptPage / MaxTranscriptPage bound a transcript read the same way
// clampMessagePage bounds a message history read, and for the same reason.
const (
	DefaultTranscriptPage = 100
	MaxTranscriptPage     = 200
)

func clampTranscriptPage(n int) int {
	if n <= 0 {
		return DefaultTranscriptPage
	}
	if n > MaxTranscriptPage {
		return MaxTranscriptPage
	}
	return n
}

// normalizeTranscriptText trims and bounds one entry. Returns false for
// anything that is not worth a row — which is what keeps a whitespace-only
// note out of the record.
func normalizeTranscriptText(s string) (string, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", false
	}
	if len(s) > CallTranscriptTextMax {
		return "", false
	}
	return s, true
}

// entryTime decides what a transcript entry is stamped with.
//
// The sender's clock orders the transcript — that is what makes it read in the
// order the room experienced rather than the order requests happened to land —
// but a client clock is client input. Anything outside a day either side of now
// is a clock that is wrong (or a caller trying to bury an entry at the top or
// the bottom of the record), and the server's own time is the honest answer for
// those.
func entryTime(clientMs int64) time.Time {
	now := time.Now().UTC()
	if clientMs <= 0 {
		return now
	}
	t := time.UnixMilli(clientMs).UTC()
	if t.Before(now.Add(-24*time.Hour)) || t.After(now.Add(24*time.Hour)) {
		return now
	}
	return t
}

// callHostOrgForRead answers "may this caller see this call at all, and whose
// meeting is it". The SELECT is the authorization: the calls RLS policy
// (`call_access`, 0015_calls.sql) admits the ENTIRE hosting org, not just the
// roster — same deliberate policy GetCall and RecordingForCall document (any
// org member may read back their own org's meeting content; the roster
// disjunct is what additionally lets a cross-org guest who attended read it
// too) — so ErrNoRows here is a real refusal (a different org, and never on
// this call's roster) rather than a missing row.
func (s *Store) callHostOrgForRead(ctx context.Context, orgID, callerID, callID string) (string, error) {
	var host string
	err := s.withCaller(ctx, orgID, callerID, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `SELECT org_id FROM calls WHERE id = $1`, callID).Scan(&host)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrForbidden
		}
		return err
	})
	return host, err
}

// callHostOrgForWrite is the same question for a WRITE, and it asks more: you
// must have been on the roster. Being in the hosting org is not enough, so a
// colleague who was never in the meeting cannot add to its record.
func (s *Store) callHostOrgForWrite(ctx context.Context, orgID, callerID, callID string) (string, error) {
	var host string
	err := s.withCaller(ctx, orgID, callerID, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `
			SELECT c.org_id FROM calls c
			JOIN call_participants p ON p.call_id = c.id AND p.user_id = $2
			WHERE c.id = $1`, callID, callerID).Scan(&host)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrForbidden
		}
		return err
	})
	return host, err
}

// AppendCallChat records one room-wide chat message against a meeting.
//
// Idempotent on the client's own entry id, which is what makes a retried
// request — or the same message reaching the server twice because the sender's
// connection blipped — one row rather than two. The id comes from the client
// because the data channel already minted one and the two copies of a message
// have to be the same message.
func (s *Store) AppendCallChat(
	ctx context.Context, orgID, senderID, callID, entryID, text string, sentAtMs int64,
) (*CallChatDTO, error) {
	body, ok := normalizeTranscriptText(text)
	if !ok {
		return nil, ErrTranscriptTextInvalid
	}
	key, ok := clientEntryKey(entryID)
	if !ok {
		return nil, ErrTranscriptEntryIDInvalid
	}
	hostOrg, err := s.callHostOrgForWrite(ctx, orgID, senderID, callID)
	if err != nil {
		return nil, err
	}
	at := entryTime(sentAtMs)

	// Ciphertext + row, under bypass. See this file's header for why.
	// The row id the caller gets back is whatever ended up stored — the one we
	// minted, or the one an earlier identical request already did. RETURNING on
	// the upsert is what makes a retry answer with the SAME entry rather than a
	// second one the client would then hold two copies of.
	//
	// body_enc is RETURNED and decrypted below rather than trusting `body`, the
	// plaintext of THIS call's argument: on the conflict path the DO UPDATE is a
	// no-op that leaves an EXISTING row's body_enc untouched, so a retry whose
	// text differs from the original (a flaky-connection resend, or a client
	// bug) must echo back what is actually stored — the same "id reuse means
	// this is a retry, answer with what is really there" rule the id itself
	// already follows, applied to the body as well.
	id := uuid.Must(uuid.NewV7()).String()
	var storedText string
	err = s.withBypass(ctx, func(tx pgx.Tx) error {
		enc, eerr := s.crypto.Encrypt(ctx, tx, hostOrg, body)
		if eerr != nil {
			return eerr
		}
		var cipher []byte
		if qerr := tx.QueryRow(ctx, `
			INSERT INTO call_chat_messages
			  (id, call_id, org_id, sender_id, client_entry_id, body_enc, sent_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
			ON CONFLICT (call_id, sender_id, client_entry_id)
			  DO UPDATE SET id = call_chat_messages.id
			RETURNING id, sent_at, body_enc`,
			id, callID, hostOrg, senderID, key, enc, at).Scan(&id, &at, &cipher); qerr != nil {
			return qerr
		}
		dec, derr := s.crypto.Decrypt(ctx, tx, hostOrg, cipher)
		if derr != nil {
			return derr
		}
		storedText = dec
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &CallChatDTO{
		ID: id, CallID: callID, SenderID: senderID, Text: storedText, SentAt: isoTime(at),
	}, nil
}

// AppendCallNote records one shared note against a meeting.
func (s *Store) AppendCallNote(
	ctx context.Context, orgID, authorID, callID, entryID, text string, atMs int64,
) (*CallNoteDTO, error) {
	body, ok := normalizeTranscriptText(text)
	if !ok {
		return nil, ErrTranscriptTextInvalid
	}
	key, ok := clientEntryKey(entryID)
	if !ok {
		return nil, ErrTranscriptEntryIDInvalid
	}
	hostOrg, err := s.callHostOrgForWrite(ctx, orgID, authorID, callID)
	if err != nil {
		return nil, err
	}
	at := entryTime(atMs)

	// See AppendCallChat's doc comment: body_enc is RETURNED and decrypted
	// below, not trusted from `body`, because the conflict path's DO UPDATE
	// never touches an existing row's body_enc.
	id := uuid.Must(uuid.NewV7()).String()
	var storedText string
	err = s.withBypass(ctx, func(tx pgx.Tx) error {
		enc, eerr := s.crypto.Encrypt(ctx, tx, hostOrg, body)
		if eerr != nil {
			return eerr
		}
		var cipher []byte
		if qerr := tx.QueryRow(ctx, `
			INSERT INTO call_notes
			  (id, call_id, org_id, author_id, client_entry_id, body_enc, written_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
			ON CONFLICT (call_id, author_id, client_entry_id)
			  DO UPDATE SET id = call_notes.id
			RETURNING id, written_at, body_enc`,
			id, callID, hostOrg, authorID, key, enc, at).Scan(&id, &at, &cipher); qerr != nil {
			return qerr
		}
		dec, derr := s.crypto.Decrypt(ctx, tx, hostOrg, cipher)
		if derr != nil {
			return derr
		}
		storedText = dec
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &CallNoteDTO{
		ID: id, CallID: callID, AuthorID: authorID, Text: storedText, WrittenAt: isoTime(at),
	}, nil
}

// rawTranscriptRow is one row BEFORE decrypt, so the row cursor can be fully
// drained before any Decrypt query runs on the same tx — a Decrypt while rows
// is still open errors with "conn busy", the same constraint every other reader
// in this package works around.
type rawTranscriptRow struct {
	id     string
	who    string
	at     time.Time
	cipher []byte
}

// readTranscript is the body both list methods share: authorize, page the rows
// oldest-first, decrypt, and hand back the cursor that continues the read.
//
// Oldest first, unlike every other history in this service. A transcript is
// read forwards — it is a conversation, not a feed — and paging it newest-first
// would mean assembling it backwards in the client.
func (s *Store) readTranscript(
	ctx context.Context, orgID, callerID, callID, table, whoCol, atCol, cursor string, limit int,
) ([]rawTranscriptRow, []string, *string, error) {
	limit = clampTranscriptPage(limit)
	hostOrg, err := s.callHostOrgForRead(ctx, orgID, callerID, callID)
	if err != nil {
		return nil, nil, nil, err
	}
	curAt, curID, err := decodeTranscriptCursor(cursor)
	if err != nil {
		return nil, nil, nil, ErrTranscriptCursorInvalid
	}

	var raws []rawTranscriptRow
	var texts []string
	var next *string
	err = s.withBypass(ctx, func(tx pgx.Tx) error {
		// Plus one to detect whether another page exists. Keyset on (at, id):
		// the id tie-breaks two entries written inside the same millisecond, so
		// a page boundary can neither repeat nor skip one.
		//
		// The table and column names are OURS — two fixed call sites below, never
		// request input — so this concatenation cannot carry anything a caller
		// supplied. Every value is still a bound parameter.
		rows, qerr := tx.Query(ctx, `
			SELECT id, `+whoCol+`, `+atCol+`, body_enc
			FROM `+table+`
			WHERE call_id = $1
			  AND ($2 = '' OR `+atCol+` > $3 OR (`+atCol+` = $3 AND id > $4))
			ORDER BY `+atCol+` ASC, id ASC
			LIMIT $5`, callID, cursor, curAt, curID, limit+1)
		if qerr != nil {
			return qerr
		}
		for rows.Next() {
			var r rawTranscriptRow
			if serr := rows.Scan(&r.id, &r.who, &r.at, &r.cipher); serr != nil {
				rows.Close()
				return serr
			}
			raws = append(raws, r)
		}
		rows.Close()
		if rerr := rows.Err(); rerr != nil {
			return rerr
		}
		if len(raws) > limit {
			raws = raws[:limit]
			last := raws[len(raws)-1]
			c := encodeTranscriptCursor(isoNano(last.at), last.id)
			next = &c
		}
		// Cursor drained; decrypting on this tx is safe now.
		texts = make([]string, len(raws))
		for i, r := range raws {
			dec, derr := s.crypto.Decrypt(ctx, tx, hostOrg, r.cipher)
			if derr != nil {
				return derr
			}
			texts[i] = dec
		}
		return nil
	})
	if err != nil {
		return nil, nil, nil, err
	}
	return raws, texts, next, nil
}

// ListCallChat returns a meeting's chat transcript, oldest first.
func (s *Store) ListCallChat(
	ctx context.Context, orgID, callerID, callID, cursor string, limit int,
) (*CallChatPageDTO, error) {
	raws, texts, next, err := s.readTranscript(
		ctx, orgID, callerID, callID, "call_chat_messages", "sender_id", "sent_at", cursor, limit)
	if err != nil {
		return nil, err
	}
	out := &CallChatPageDTO{Items: make([]CallChatDTO, 0, len(raws)), NextCursor: next}
	for i, r := range raws {
		out.Items = append(out.Items, CallChatDTO{
			ID: r.id, CallID: callID, SenderID: r.who, Text: texts[i], SentAt: isoTime(r.at),
		})
	}
	return out, nil
}

// ListCallNotes returns a meeting's shared notes, oldest first.
func (s *Store) ListCallNotes(
	ctx context.Context, orgID, callerID, callID, cursor string, limit int,
) (*CallNotePageDTO, error) {
	raws, texts, next, err := s.readTranscript(
		ctx, orgID, callerID, callID, "call_notes", "author_id", "written_at", cursor, limit)
	if err != nil {
		return nil, err
	}
	out := &CallNotePageDTO{Items: make([]CallNoteDTO, 0, len(raws)), NextCursor: next}
	for i, r := range raws {
		out.Items = append(out.Items, CallNoteDTO{
			ID: r.id, CallID: callID, AuthorID: r.who, Text: texts[i], WrittenAt: isoTime(r.at),
		})
	}
	return out, nil
}

// clientEntryKey normalises the idempotency key a sender supplies.
//
// This is the id the client already minted for the data-channel copy of the
// entry, and it is what makes a retried request — or the same message reaching
// us twice on a flaky connection — one row instead of two. It is NOT the
// primary key: the client composes it itself, and a client-chosen primary key
// on a shared table is not a trade worth making. See migration 0029.
//
// An empty key is allowed and one is generated, for a caller with no
// data-channel copy to match. Bounded because it is client input and it is
// indexed.
func clientEntryKey(id string) (string, bool) {
	id = strings.TrimSpace(id)
	if id == "" {
		return uuid.Must(uuid.NewV7()).String(), true
	}
	if len(id) > 64 {
		return "", false
	}
	return id, true
}

func isoNano(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }

// ─────────────────────────────────────────────────────────────────────────────
// Cursor encoding — base64(JSON {at, id}), the same shape and the same reasons
// as encodeInboxCursor. Opaque to clients.
// ─────────────────────────────────────────────────────────────────────────────

type transcriptCursor struct {
	At string `json:"at"`
	ID string `json:"id"`
}

func encodeTranscriptCursor(at, id string) string {
	raw, _ := json.Marshal(transcriptCursor{At: at, ID: id})
	return base64.RawURLEncoding.EncodeToString(raw)
}

// decodeTranscriptCursor returns the keyset bound. The zero-value sentinel is
// the epoch and the nil uuid: the `$2 = ”` guard already makes the comparison
// a no-op on the first page, but Postgres does not guarantee left-to-right OR
// short-circuiting, so both must still be values the comparison can evaluate.
func decodeTranscriptCursor(s string) (time.Time, string, error) {
	if s == "" {
		return time.Unix(0, 0).UTC(), "00000000-0000-0000-0000-000000000000", nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return time.Time{}, "", err
	}
	var c transcriptCursor
	if err := json.Unmarshal(raw, &c); err != nil {
		return time.Time{}, "", err
	}
	at, err := time.Parse(time.RFC3339Nano, c.At)
	if err != nil {
		return time.Time{}, "", err
	}
	if _, err := uuid.Parse(c.ID); err != nil {
		return time.Time{}, "", err
	}
	return at, c.ID, nil
}
