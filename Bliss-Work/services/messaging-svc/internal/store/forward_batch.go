package store

import (
	"context"

	"github.com/google/uuid"
)

// Batch forwarding: N source messages, in their canonical chronological
// order, to M destinations — the store layer under POST /api/v1/forwards.
//
// Built entirely out of forward_internal.go's existing per-destination and
// per-message halves (resolveForwardDest*/forwardOneTo*): a batch forward is
// the same operation ForwardMessage already performs, run once per source
// message inside one destination's transaction instead of once total. See
// forwardOneToConversation's doc comment for why that transaction-sharing
// needed appendMessage split into appendMessage/appendMessageTx first.

// forwardBatchNamespace is the fixed UUIDv5 namespace a batch forward derives
// its per-(source, destination) client_msg_id from, given one client-supplied
// batch id.
//
// NEVER CHANGE THIS VALUE. The derived ids are the only thing standing
// between a retried batch and a duplicate delivery — change the namespace and
// every in-flight retry re-delivers everything it already delivered.
var forwardBatchNamespace = uuid.MustParse("3538bc31-9b88-4d71-9b50-e93ed4a1d4f7")

// derivedClientMsgID makes the N×M idempotency keys the destination tables'
// existing UNIQUE (scope, sender_id, client_msg_id) constraints need, from
// ONE client-supplied batch id — so the client mints and tracks a single id
// per submission, not N×M of them. client_msg_id is a `uuid` column, so a v5
// (SHA-1) derivation is the shape that fits it.
func derivedClientMsgID(clientBatchID, targetKind, targetID, sourceMessageID string) string {
	return uuid.NewSHA1(forwardBatchNamespace,
		[]byte(clientBatchID+"|"+targetKind+"|"+targetID+"|"+sourceMessageID)).String()
}

// ForwardDestinationResult is one destination's outcome from a batch forward.
// Destination-granular rather than per (message × destination) on purpose: a
// destination gets ONE transaction for the whole ordered batch, so it either
// takes all of it or none of it, and a per-pair report would be N identical
// rows saying the same thing about the same destination.
type ForwardDestinationResult struct {
	Target         ForwardTarget
	ConversationID string
	ChannelID      string
	// MessageIDs are the delivered clones, in source-seq order.
	MessageIDs []string
	// Err is nil on success.
	Err error
}

// ForwardMessages forwards every id in sourceMessageIDs — in their canonical
// `seq` order, never the order the caller selected them in — to every target
// in targets, and reports each destination's outcome independently.
//
// Sources are resolved and authorized ONCE, up front, via
// ForwardSourcesResolve: any failure there (an unreadable source, or a
// selection spanning more than one conversation/channel) fails the WHOLE
// request, because it is a precondition on what is being forwarded, not an
// outcome any one destination can be blamed for.
//
// Each destination then gets its OWN transaction. One target failing —
// blocked, not a member, gone — is caught and recorded in that target's own
// result, and the loop CONTINUES: a destination that already succeeded, or
// one still to come, must never be rolled back or blocked by a different
// destination's refusal.
//
// A batch has no natural per-(message, destination) client id the way a
// single forward's clientMsgId is a natural per-call id, so one is derived
// from clientBatchID for every pair (see derivedClientMsgID) — retrying the
// whole batch with the same clientBatchID re-uses every clone that already
// landed and writes only the ones that did not.
func (s *Store) ForwardMessages(
	ctx context.Context, orgID, forwarderID string,
	sourceMessageIDs []string, targets []ForwardTarget, clientBatchID string,
) ([]ForwardDestinationResult, error) {
	sourceMessageIDs = dedupeStrings(sourceMessageIDs)
	targets = dedupeTargets(targets)

	fcs, err := s.ForwardSourcesResolve(ctx, orgID, forwarderID, sourceMessageIDs)
	if err != nil {
		return nil, err
	}

	results := make([]ForwardDestinationResult, 0, len(targets))
	for _, t := range targets {
		if !t.Valid() {
			results = append(results, ForwardDestinationResult{Target: t, MessageIDs: []string{}, Err: ErrForbidden})
			continue
		}
		// A client that has disconnected should stop the loop rather than
		// grind through every remaining destination.
		if ctx.Err() != nil {
			break
		}

		// Non-nil from the start (not just after the first successful
		// append) so a destination that fails before appending anything —
		// or fails Valid()/resolve — still serializes as `[]`, not `null`.
		res := ForwardDestinationResult{Target: t, MessageIDs: []string{}}
		txErr := RetryOnSerializationFailure(ctx, 3, func(ctx context.Context) error {
			// Reset on every attempt: a serialization-failure retry re-runs
			// this closure from scratch, and a partially-filled slice from an
			// earlier attempt must not survive into the next one.
			res.MessageIDs = res.MessageIDs[:0]

			tx, err := s.pool.Begin(ctx)
			if err != nil {
				return err
			}
			defer tx.Rollback(ctx)
			if err := setOrgGUC(ctx, tx, orgID); err != nil {
				return err
			}

			if t.Kind == ForwardTargetChannel {
				if err := s.resolveForwardDestChannel(ctx, tx, orgID, forwarderID, t.ID); err != nil {
					return err
				}
				res.ChannelID = t.ID
				for _, fc := range fcs {
					cmid := derivedClientMsgID(clientBatchID, t.Kind, t.ID, fc.SourceMessageID)
					msgID, err := s.forwardOneToChannel(ctx, tx, orgID, forwarderID, fc.SourceMessageID, t.ID, cmid, fc)
					if err != nil {
						return err
					}
					res.MessageIDs = append(res.MessageIDs, msgID)
				}
			} else {
				convID, err := s.resolveForwardDestUser(ctx, tx, orgID, forwarderID, t.ID)
				if err != nil {
					return err
				}
				res.ConversationID = convID
				for _, fc := range fcs {
					cmid := derivedClientMsgID(clientBatchID, t.Kind, t.ID, fc.SourceMessageID)
					msgID, err := s.forwardOneToConversation(ctx, tx, orgID, forwarderID, fc.SourceMessageID, convID, t.ID, cmid, fc)
					if err != nil {
						return err
					}
					res.MessageIDs = append(res.MessageIDs, msgID)
				}
			}
			// One notice per private source channel for the WHOLE batch, not per
			// message or per destination: the key is the batch id, so the first
			// destination to commit writes it and every later one dedupes. It is
			// written only here, after this destination's forwards succeeded, so
			// a batch whose every destination fails posts nothing.
			if err := s.writeForwardNotices(ctx, tx, orgID, forwarderID, t.channelID(),
				"batch:"+clientBatchID, fcs...); err != nil {
				return err
			}
			return tx.Commit(ctx)
		})
		res.Err = txErr
		results = append(results, res)
	}
	return results, nil
}

// dedupeStrings drops repeats, keeping first-seen order.
func dedupeStrings(in []string) []string {
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, v := range in {
		if _, ok := seen[v]; ok {
			continue
		}
		seen[v] = struct{}{}
		out = append(out, v)
	}
	return out
}

// dedupeTargets drops repeats (by kind+id), keeping first-seen order.
func dedupeTargets(in []ForwardTarget) []ForwardTarget {
	seen := make(map[string]struct{}, len(in))
	out := make([]ForwardTarget, 0, len(in))
	for _, t := range in {
		key := t.Kind + "|" + t.ID
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, t)
	}
	return out
}
