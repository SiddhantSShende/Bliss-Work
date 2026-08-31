package store

import (
	"encoding/json"
	"testing"
)

// The wire shape of a meeting's transcript, pinned.
//
// These DTOs are parsed on the other side by zod schemas that name every field
// (CallChatMessageDTO, CallNoteDTO, CallChatPageDTO, CallPageDTO in
// packages/shared/src/types/domain.ts). A renamed or dropped json tag here does
// not fail any Go test, does not fail the build, and does not error at runtime
// either — zod's `.default([])` and `.nullish()` turn it into an EMPTY
// TRANSCRIPT, which reads as "nothing was said in this meeting".
//
// packages/shared/src/types/callTranscript.contract.test.ts parses the SAME
// literals through those schemas. The pair is the contract: change a tag here
// and this fails; change it in both and the TS side still has to agree.
func TestCallTranscriptWireShape(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   any
		want string
	}{
		{
			name: "chat message",
			in: CallChatDTO{
				ID:       "11111111-1111-1111-1111-111111111111",
				CallID:   "22222222-2222-2222-2222-222222222222",
				SenderID: "33333333-3333-3333-3333-333333333333",
				Text:     "Shall we ship it?",
				SentAt:   "2026-08-01T09:10:00.000Z",
			},
			want: `{"id":"11111111-1111-1111-1111-111111111111",` +
				`"callId":"22222222-2222-2222-2222-222222222222",` +
				`"senderId":"33333333-3333-3333-3333-333333333333",` +
				`"text":"Shall we ship it?","sentAt":"2026-08-01T09:10:00.000Z"}`,
		},
		{
			name: "note",
			in: CallNoteDTO{
				ID:        "44444444-4444-4444-4444-444444444444",
				CallID:    "22222222-2222-2222-2222-222222222222",
				AuthorID:  "55555555-5555-5555-5555-555555555555",
				Text:      "Decide the rollout date",
				WrittenAt: "2026-08-01T09:20:00.000Z",
			},
			want: `{"id":"44444444-4444-4444-4444-444444444444",` +
				`"callId":"22222222-2222-2222-2222-222222222222",` +
				`"authorId":"55555555-5555-5555-5555-555555555555",` +
				`"text":"Decide the rollout date","writtenAt":"2026-08-01T09:20:00.000Z"}`,
		},
		{
			// The LAST page: nextCursor must be present and null, not omitted.
			// "no more pages" is what stops the client asking for another one,
			// and an absent field and a null one are the same to zod's nullish
			// — but only because the schema was written to accept both. Pinned
			// so the server keeps sending the explicit answer.
			name: "empty chat page",
			in:   CallChatPageDTO{Items: []CallChatDTO{}},
			want: `{"items":[],"nextCursor":null}`,
		},
		{
			name: "history page with a cursor",
			in: CallPageDTO{
				Items:      []CallDTO{},
				NextCursor: ptr("eyJhdCI6IjIwMjYifQ"),
			},
			want: `{"items":[],"nextCursor":"eyJhdCI6IjIwMjYifQ"}`,
		},
	} {
		got, err := json.Marshal(tc.in)
		if err != nil {
			t.Fatalf("%s: marshal: %v", tc.name, err)
		}
		if string(got) != tc.want {
			t.Errorf("%s wire shape changed:\n got  %s\n want %s\n\n"+
				"If this is deliberate, update packages/shared/src/types/domain.ts AND "+
				"callTranscript.contract.test.ts in the same change — a field the client "+
				"cannot find renders as an empty transcript, not as an error.",
				tc.name, got, tc.want)
		}
	}
}
