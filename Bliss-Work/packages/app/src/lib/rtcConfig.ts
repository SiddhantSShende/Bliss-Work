/**
 * STUN-only WebRTC configuration for Phase 10 P2P file transfer.
 *
 * Per Design Decision #4 we deliberately ship NO TURN. ~80% of transfers
 * succeed via direct P2P over the user's home/office network. The remaining
 * 10–20% behind symmetric NATs fail gracefully with an inline "Direct
 * transfer unavailable" — they do NOT fall back through our servers (the
 * whole point of P2P is the 10 GB cap with zero server bandwidth cost).
 *
 * Multiple public STUN endpoints are listed so the loss of any single
 * Google STUN host doesn't take the feature down.
 */
export const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
  ],
  iceTransportPolicy: "all",
  bundlePolicy: "max-bundle",
};

/** Chunk size for the file-transfer DataChannel. 256 KB is a SCTP-friendly
 *  sweet spot — large enough to amortize syscall + crypto cost, small enough
 *  that one bad chunk doesn't take a long retransmit cycle. */
export const CHUNK_SIZE = 256 * 1024;

/** Backpressure ceiling. Above this many bytes buffered we PAUSE reads. */
export const BUFFERED_AMOUNT_HIGH = 8 * 1024 * 1024;

/** Resume reads when the buffer drops below this. Matches our high watermark
 *  one-to-one — there's no benefit to a hysteresis gap on a single-producer
 *  channel. */
export const BUFFERED_AMOUNT_LOW = 4 * 1024 * 1024;

/** Soft cap for files in the browser (no Node fs). Above this size we hide
 *  the 📎 button in the web app and tell the user to use the desktop app. */
export const WEB_FILE_SIZE_CAP = 100 * 1024 * 1024;

/** ICE-failure watchdog — if iceConnectionState lands in 'failed' or
 *  'disconnected' for this long, surface "Direct transfer unavailable". */
export const ICE_FAILURE_GRACE_MS = 10_000;
