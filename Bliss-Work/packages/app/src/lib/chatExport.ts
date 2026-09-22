/**
 * "Export Chat" — the loaded conversation, as a plain-text transcript.
 *
 * Text rather than JSON or a spreadsheet: the thing people export a chat for is
 * to read it, quote it, or attach it to a ticket, and the task exports that go
 * through exceljs exist because a task list is tabular. A conversation is not.
 *
 * Entirely client-side, and it has to be: message bodies are encrypted at rest,
 * so the server could not render this even if it had an endpoint for it. What
 * gets written is therefore exactly what the reader can see — the history this
 * thread has loaded — and the header says so rather than implying the whole
 * conversation is in the file.
 */
import { readablePrefix } from "./chatEnvelope";
import { downloadBlob } from "./download";
import i18n from "../i18n";

interface TranscriptMessage {
  body: string;
  /** ISO timestamp. Absent on an optimistic message that has not landed. */
  at?: string;
  senderId: string;
  senderName?: string;
  deletedForAll?: boolean;
}

interface TranscriptOptions {
  /** "#general" or the peer's name — whatever titles the conversation on screen. */
  title: string;
  /** The reader, so their own lines read "You" as they do in the thread. */
  meId: string;
  /** Injected so the header is testable and the filename is stable within a run. */
  now: Date;
}

/**
 * `YYYY-MM-DD HH:MM` in the reader's own timezone.
 *
 * Hand-formatted rather than `toLocaleString`, whose output depends on the
 * host's locale: a transcript is a document someone may file or diff, and it
 * should not read differently on a colleague's machine.
 */
function stamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function lineFor(m: TranscriptMessage, meId: string): string {
  const when = m.at ? stamp(new Date(m.at)) : "—";
  const who = m.senderId === meId ? i18n.t("chatThread:shared.you") : (m.senderName ?? i18n.t("chatThread:export.unknownSender"));
  // readablePrefix, so an attachment reads "🖼️ photo.jpg · 2.0 MB" rather than
  // the envelope's JSON — the same text every other non-rendering surface shows.
  const body = m.deletedForAll
    ? i18n.t("chatThread:export.deletedMessage")
    : readablePrefix(m.body) || i18n.t("chatThread:export.noText");
  return `[${when}] ${who}: ${body}`;
}

export function buildTranscript(
  messages: readonly TranscriptMessage[],
  { title, meId, now }: TranscriptOptions,
): string {
  const header = [
    i18n.t("chatThread:export.header", { brand: "BlissWork" }),
    title,
    i18n.t("chatThread:export.exportedSummary", { timestamp: stamp(now), count: messages.length }),
    "",
  ];
  return [...header, ...messages.map((m) => lineFor(m, meId))].join("\n") + "\n";
}

/** `blisswork-general-2026-08-20.txt`. */
function transcriptFilename(title: string, now: Date): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "chat";
  return `blisswork-${slug}-${stamp(now).slice(0, 10)}.txt`;
}

/** Build the transcript and hand it to the browser as a download. */
export function exportChatTranscript(
  messages: readonly TranscriptMessage[],
  options: TranscriptOptions,
): void {
  const text = buildTranscript(messages, options);
  downloadBlob(
    new Blob([text], { type: "text/plain;charset=utf-8" }),
    transcriptFilename(options.title, options.now),
  );
}
