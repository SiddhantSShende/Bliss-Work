package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

// A read cursor (conversation_members / thread_members / channel_members
// .last_read_seq) is a claim "I have seen everything up to this seq". The
// caller supplies the seq, and the unified-inbox "mark read" gesture supplies
// math.MaxInt64 to mean "everything", so a cursor taken verbatim ends up at 9.2e18:
// every message sent afterwards is already "read" (unread badge stuck at 0),
// the sender is never shown "Seen" (the receipt window (prev, upTo] is empty
// above the frontier), and a MessageRead event for seqs that do not exist goes
// to the peer. A client can equally write an arbitrary huge value directly.
//
// So every read path clamps the requested seq to the highest seq that has
// actually been allocated in that conversation or channel — its seq_counter,
// which only ever grows — inside the same transaction that moves the cursor.
// Seqs are allocated by incrementing that counter under the row lock, so
// nothing a reader can legitimately have seen is above it, and nothing sent
// later is below it.

// conversationSeqCeiling is the highest seq ever allocated in a conversation.
// Threads draw their seqs from the same counter (messages.seq is per
// conversation), so it bounds a thread's cursor too.
func conversationSeqCeiling(ctx context.Context, tx pgx.Tx, convID string) (int64, error) {
	var ceiling int64
	err := tx.QueryRow(ctx, `SELECT seq_counter FROM conversations WHERE id = $1`, convID).Scan(&ceiling)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrForbidden
	}
	return ceiling, err
}

// channelSeqCeiling is the highest seq ever allocated in a channel.
func channelSeqCeiling(ctx context.Context, tx pgx.Tx, channelID string) (int64, error) {
	var ceiling int64
	err := tx.QueryRow(ctx, `SELECT seq_counter FROM channels WHERE id = $1`, channelID).Scan(&ceiling)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrForbidden
	}
	return ceiling, err
}
