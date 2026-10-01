/**
 * The hand-off between the socket bridge and the "meeting scheduled" card
 * (features/ScheduledMeetingNotice).
 *
 * A plain window event, the same shape as MeetingSession's
 * announceIncomingMeeting, for the same reason: lib/queryBridge has no business
 * sitting inside the card's provider tree, and a CustomEvent needs neither.
 * Kept in its own module rather than appended to MeetingSession because it is a
 * different notification — a scheduling is information, an incoming meeting is
 * an interruption — and the two must never be mistaken for one another.
 */

const SCHEDULED_MEETING_EVENT = "taskboard:meeting-scheduled";

export interface ScheduledMeeting {
  /** The call.scheduled event's own id — what the card dedupes on, so a repeat
   *  delivery of ONE event never raises a second card while a genuinely new
   *  scheduling of the same call (an edit, a reschedule) still does. */
  eventId: string;
  callId: string;
  title: string;
  /** ISO start time. Absent for a call that was never given one ("meet now"). */
  scheduledAt?: string;
}

export function announceScheduledMeeting(meeting: ScheduledMeeting) {
  window.dispatchEvent(new CustomEvent(SCHEDULED_MEETING_EVENT, { detail: meeting }));
}

export function onScheduledMeetingAnnounced(listener: (meeting: ScheduledMeeting) => void) {
  const handle = (event: Event) => {
    const detail = (event as CustomEvent<Partial<ScheduledMeeting> | undefined>).detail;
    if (typeof detail?.eventId !== "string" || !detail.eventId) return;
    if (typeof detail.callId !== "string" || !detail.callId) return;
    listener({
      eventId: detail.eventId,
      callId: detail.callId,
      title: typeof detail.title === "string" ? detail.title : "",
      scheduledAt: typeof detail.scheduledAt === "string" ? detail.scheduledAt : undefined,
    });
  };
  window.addEventListener(SCHEDULED_MEETING_EVENT, handle);
  return () => window.removeEventListener(SCHEDULED_MEETING_EVENT, handle);
}
