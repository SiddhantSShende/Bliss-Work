/**
 * WebRTC P2P file-transfer state machines (sender + receiver) for Phase 10.
 *
 * Wire protocol on a single ordered DataChannel:
 *
 *   1. SENDER  → "INIT"     (control JSON, sha256 + total size + chunkCount)
 *   2. RECEIVER → "READY"   (control JSON, optional resumeFromChunkIndex)
 *   3. SENDER  → binary frames, one per chunk:
 *        [ 1-byte tag = 0x01 ][ 4-byte chunkIndex BE ][ payload ]
 *   4. SENDER  → "FIN"       (control JSON with the full sha256 again)
 *   5. RECEIVER → "DONE" or "MISMATCH"
 *
 * Signaling (offer / answer / ICE) rides the existing ws-gateway as Phase 9
 * control frames — never persisted, never produced to Kafka.
 *
 * Failure mode: if iceConnectionState lands in failed/disconnected for
 * ICE_FAILURE_GRACE_MS the transfer is abandoned and the receiver bubble
 * flips to FAILED with "Direct transfer unavailable" — explicitly NO
 * fallback to a server-mediated upload.
 *
 * This module is renderer-only. The Composer wires the `offer` flow; the
 * FileAttachmentBubble drives the `answer` flow.
 */
import {
  BUFFERED_AMOUNT_HIGH,
  BUFFERED_AMOUNT_LOW,
  CHUNK_SIZE,
  ICE_FAILURE_GRACE_MS,
  RTC_CONFIG,
} from "./rtcConfig";

export type TransferProgress = {
  bytesDone: number;
  bytesTotal: number;
  chunkIndex: number;
  chunkTotal: number;
};

export type TransferState =
  | { kind: "OFFERED" }
  | { kind: "CONNECTING" }
  | { kind: "TRANSFERRING"; progress: TransferProgress }
  | { kind: "DONE" }
  | { kind: "FAILED"; reason: string };

export interface FileOfferMeta {
  offerId: string;
  name: string;
  size: number;
  sha256: string;
  mimeType: string;
}

/** Sender-side signaling adapter — emits offer/ice/cancel via the WS layer. */
export interface SenderWire {
  sendOffer: (toUserId: string, offerId: string, sdp: string) => void;
  sendIce: (toUserId: string, offerId: string, candidate: string) => void;
  sendCancel: (toUserId: string, offerId: string, reason: string) => void;
  onAnswer: (cb: (offerId: string, sdp: string, resumeFromChunkIndex?: number) => void) => () => void;
  onIce: (cb: (offerId: string, candidate: string) => void) => () => void;
  onUnreachable: (cb: (offerId: string) => void) => () => void;
}

/** Receiver-side signaling adapter — mirrors SenderWire for the inbound flow. */
export interface ReceiverWire {
  sendAnswer: (toUserId: string, offerId: string, sdp: string, resumeFromChunkIndex?: number) => void;
  sendIce: (toUserId: string, offerId: string, candidate: string) => void;
  sendCancel: (toUserId: string, offerId: string, reason: string) => void;
  onIce: (cb: (offerId: string, candidate: string) => void) => () => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared ICE-failure watchdog (sender + receiver)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Installs `pc.oniceconnectionstatechange`, debouncing it against a single
 * timer: a transition into failed/disconnected arms a timeout, any other
 * transition (including an oscillating failed→connected→failed sequence)
 * clears it, and `onFail` only fires if the connection is STILL bad once
 * ICE_FAILURE_GRACE_MS elapses. Identical for the sender and receiver — both
 * used to hand-roll this ~20-line handler.
 *
 * Returns a `clear()` that cancels any pending timer; callers must invoke it
 * from their own teardown so a stale watchdog can't fire after cleanup.
 */
function installIceFailureWatchdog(
  pc: RTCPeerConnection,
  isCancelled: () => boolean,
  onFail: () => void,
): () => void {
  let watchdog: ReturnType<typeof setTimeout> | null = null;

  const clear = () => {
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = null;
    }
  };

  pc.oniceconnectionstatechange = () => {
    if (isCancelled()) return;
    const bad =
      pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected";
    // Single watchdog: clear any previous timer so an oscillating
    // failed→connected→failed sequence doesn't queue multiple failures.
    clear();
    if (!bad) return;
    watchdog = setTimeout(() => {
      watchdog = null;
      if (isCancelled()) return;
      const stillBad =
        pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected";
      if (stillBad) onFail();
    }, ICE_FAILURE_GRACE_MS);
  };

  return clear;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sender
// ─────────────────────────────────────────────────────────────────────────────

export interface SenderHandle {
  cancel: () => void;
  state: () => TransferState;
}

export function startSenderTransfer(opts: {
  file: File;
  meta: FileOfferMeta;
  peerUserId: string;
  wire: SenderWire;
  onProgress: (p: TransferProgress) => void;
  onState: (s: TransferState) => void;
}): SenderHandle {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const channel = pc.createDataChannel(`file-${opts.meta.offerId}`, { ordered: true });
  channel.binaryType = "arraybuffer";
  channel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW;

  let cancelled = false;
  // Overwritten below with installIceFailureWatchdog's real clear() once the
  // watchdog is installed; a no-op until then so teardown() can call it
  // unconditionally even if it runs before that assignment happens.
  let clearIceWatchdog: () => void = () => {};
  let state: TransferState = { kind: "OFFERED" };
  // Subscriber unsubscribe handles — populated below. We tear them down in
  // teardown() on every terminal path so we don't leak the signaling fan-in
  // across transfers in a long-lived renderer session.
  let offAnswer: (() => void) | null = null;
  let offIce: (() => void) | null = null;
  let offUnreachable: (() => void) | null = null;
  // push()'s backpressure wait, while pending — see teardown() below.
  let bufferedAmountLowResolve: (() => void) | null = null;

  const update = (s: TransferState) => {
    state = s;
    opts.onState(s);
  };

  const teardown = () => {
    clearIceWatchdog();
    offAnswer?.();
    offIce?.();
    offUnreachable?.();
    offAnswer = offIce = offUnreachable = null;
    // Unstick push()'s backpressure wait, on every path that reaches here —
    // not just cancel(). pc.close() below does not fire "bufferedamountlow"
    // (that only fires when bufferedAmount actually drains via a completed
    // send), so without this the promise — and the closure holding
    // opts.file — would never settle once the channel can no longer drain on
    // its own. push()'s loop re-checks channel.readyState after this
    // resolves, so it unwinds instead of trying to send on a closed channel.
    if (bufferedAmountLowResolve) {
      channel.onbufferedamountlow = null;
      const resolve = bufferedAmountLowResolve;
      bufferedAmountLowResolve = null;
      resolve();
    }
    if (pc.connectionState !== "closed") pc.close();
  };

  clearIceWatchdog = installIceFailureWatchdog(pc, () => cancelled, () => {
    update({ kind: "FAILED", reason: "Direct transfer unavailable" });
    teardown();
  });

  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      opts.wire.sendIce(opts.peerUserId, opts.meta.offerId, JSON.stringify(ev.candidate));
    }
  };

  // Hook signaling answers in.
  offAnswer = opts.wire.onAnswer(async (offerId, sdp, resume) => {
    if (offerId !== opts.meta.offerId) return;
    update({ kind: "CONNECTING" });
    try {
      await pc.setRemoteDescription({ type: "answer", sdp });
    } catch {
      update({ kind: "FAILED", reason: "Bad answer" });
      teardown();
      return;
    }
    startStreaming(resume ?? 0);
  });

  offIce = opts.wire.onIce(async (offerId, candidate) => {
    if (offerId !== opts.meta.offerId) return;
    try {
      await pc.addIceCandidate(JSON.parse(candidate));
    } catch {
      /* ignore — peer may have sent a stale candidate */
    }
  });

  offUnreachable = opts.wire.onUnreachable((offerId) => {
    if (offerId !== opts.meta.offerId) return;
    update({ kind: "FAILED", reason: "Peer unreachable" });
    teardown();
  });

  // Kick off the offer.
  (async () => {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    opts.wire.sendOffer(opts.peerUserId, opts.meta.offerId, offer.sdp ?? "");
  })().catch(() => {
    update({ kind: "FAILED", reason: "Offer creation failed" });
    teardown();
  });

  // ── streaming ─────────────────────────────────────────────────────────────
  const chunkTotal = Math.ceil(opts.meta.size / CHUNK_SIZE);
  function startStreaming(fromIndex: number) {
    let nextIndex = fromIndex;
    let bytesDone = fromIndex * CHUNK_SIZE;

    const push = async () => {
      while (!cancelled && channel.readyState === "open" && nextIndex < chunkTotal) {
        if (channel.bufferedAmount > BUFFERED_AMOUNT_HIGH) {
          await new Promise<void>((resolve) => {
            bufferedAmountLowResolve = resolve;
            channel.onbufferedamountlow = () => {
              channel.onbufferedamountlow = null;
              bufferedAmountLowResolve = null;
              resolve();
            };
          });
          continue;
        }
        const offset = nextIndex * CHUNK_SIZE;
        const slice = opts.file.slice(offset, offset + CHUNK_SIZE);
        const ab = await slice.arrayBuffer();
        // cancel()/teardown() may have run while we were awaiting the slice
        // read (e.g. the user cancelled mid-chunk, which closes the
        // RTCPeerConnection and hence this channel) — re-check before
        // touching the channel so we don't call send() on a closing/closed
        // channel and throw InvalidStateError.
        if (cancelled || channel.readyState !== "open") break;
        // header: 1B tag (0x01) + 4B BE chunk index
        const frame = new Uint8Array(5 + ab.byteLength);
        frame[0] = 0x01;
        new DataView(frame.buffer).setUint32(1, nextIndex, false);
        frame.set(new Uint8Array(ab), 5);
        try {
          channel.send(frame.buffer);
        } catch {
          // Second line of defense: a send that still throws (e.g. a race
          // between the check above and this call) fails the transfer the
          // same way the rest of this module does, instead of surfacing as
          // an unhandled rejection.
          if (!cancelled) {
            update({ kind: "FAILED", reason: "Direct transfer unavailable" });
            teardown();
          }
          return;
        }
        bytesDone += ab.byteLength;
        const progress: TransferProgress = {
          bytesDone: Math.min(bytesDone, opts.meta.size),
          bytesTotal: opts.meta.size,
          chunkIndex: nextIndex,
          chunkTotal,
        };
        opts.onProgress(progress);
        if (state.kind !== "TRANSFERRING") update({ kind: "TRANSFERRING", progress });
        nextIndex += 1;
      }
      if (!cancelled && channel.readyState === "open") {
        channel.send(
          JSON.stringify({ type: "FIN", offerId: opts.meta.offerId, sha256: opts.meta.sha256 }),
        );
      }
    };

    const beginStream = () => {
      channel.send(
        JSON.stringify({
          type: "INIT",
          offerId: opts.meta.offerId,
          name: opts.meta.name,
          size: opts.meta.size,
          chunkCount: chunkTotal,
          sha256: opts.meta.sha256,
        }),
      );
      void push();
    };
    if (channel.readyState === "open") {
      // The channel may have opened while we were awaiting setRemoteDescription;
      // in that case onopen has already fired and assigning it now does
      // nothing. Drive the INIT explicitly.
      beginStream();
    } else {
      channel.onopen = beginStream;
    }
    channel.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "DONE") {
            update({ kind: "DONE" });
            teardown();
          } else if (msg.type === "MISMATCH") {
            update({ kind: "FAILED", reason: "sha256 mismatch" });
            teardown();
          }
        } catch {
          /* ignore */
        }
      }
    };
  }

  return {
    cancel: () => {
      cancelled = true;
      opts.wire.sendCancel(opts.peerUserId, opts.meta.offerId, "sender_left");
      teardown();
      update({ kind: "FAILED", reason: "Cancelled" });
    },
    state: () => state,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Receiver
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Drives the receiver side once the user clicks Accept on a FileAttachmentBubble.
 * Listens for the sender's offer, builds an answer, streams chunks into an
 * in-memory Blob backed by a TransformStream (Phase 10 Electron path swaps
 * this for a disk-backed sink via the file-transfer.ts main bridge).
 */
export interface ReceiverHandle {
  cancel: () => void;
  state: () => TransferState;
}

/**
 * True if accepting this chunk would take the receiver past what the offer
 * itself negotiated — a peer sending more than it originally offered.
 *
 * Extracted as its own pure function (rather than inlined in the DataChannel
 * handler) specifically so it can be unit-tested without a real
 * RTCDataChannel: `maxChunkIndex`/`offerSize` MUST come from the offer
 * (FileOfferMeta.size, agreed before the peer connection carried a single
 * byte), never from anything the sender says over the channel afterward —
 * see startReceiverTransfer's own chunkTotal, which the sender's INIT frame
 * is allowed to overwrite for progress-display purposes and is therefore
 * unfit to bound anything.
 */
export function chunkExceedsOffer(
  chunkIndex: number,
  payloadByteLength: number,
  bytesReceivedSoFar: number,
  maxChunkIndex: number,
  offerSize: number,
): boolean {
  return chunkIndex >= maxChunkIndex || bytesReceivedSoFar + payloadByteLength > offerSize;
}

export function startReceiverTransfer(opts: {
  meta: FileOfferMeta;
  peerUserId: string;
  wire: ReceiverWire;
  /** Awaited offer SDP — the renderer pipes the rtc.offer frame here. */
  offerSdp: string;
  resumeFromChunkIndex?: number;
  onProgress: (p: TransferProgress) => void;
  onState: (s: TransferState) => void;
  /** Sink that consumes ordered chunks (resolves once write completes). */
  onChunk: (index: number, payload: ArrayBuffer) => Promise<void>;
  /** Finalize + verify the assembled file. Returns true if the integrity check
   *  (sha256) passed → DONE; false on mismatch → MISMATCH. */
  onDone: () => Promise<boolean>;
}): ReceiverHandle {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  let cancelled = false;
  // Overwritten below with installIceFailureWatchdog's real clear() once the
  // watchdog is installed; a no-op until then so teardown() can call it
  // unconditionally even if it runs before that assignment happens.
  let clearIceWatchdog: () => void = () => {};
  let state: TransferState = { kind: "CONNECTING" };
  // Subscribe the wire BEFORE the offer flow so we don't race the sender's
  // first ICE candidate. Populated below; torn down in teardown().
  let offIce: (() => void) | null = null;

  const update = (s: TransferState) => {
    state = s;
    opts.onState(s);
  };

  const teardown = () => {
    clearIceWatchdog();
    offIce?.();
    offIce = null;
    if (pc.connectionState !== "closed") pc.close();
  };

  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      opts.wire.sendIce(opts.peerUserId, opts.meta.offerId, JSON.stringify(ev.candidate));
    }
  };

  clearIceWatchdog = installIceFailureWatchdog(pc, () => cancelled, () => {
    update({ kind: "FAILED", reason: "Direct transfer unavailable" });
    teardown();
  });

  let chunkTotal = Math.ceil(opts.meta.size / CHUNK_SIZE);
  let bytesDone = (opts.resumeFromChunkIndex ?? 0) * CHUNK_SIZE;
  let nextExpected = opts.resumeFromChunkIndex ?? 0;
  // Immutable, derived from the OFFER's own size — agreed before this peer
  // connection carried a single byte. `chunkTotal` above gets overwritten
  // from the sender's own INIT frame just below (display purposes: "in case
  // the sender re-segmented"), which makes it peer-controlled and unfit to
  // bound anything. A peer that keeps streaming past what it originally
  // offered fails the transfer here instead of writing forever.
  const maxChunkIndex = chunkTotal;

  pc.ondatachannel = (ev) => {
    const dc = ev.channel;
    dc.binaryType = "arraybuffer";

    dc.onmessage = (m) => {
      // The dispatcher is intentionally a plain (non-async) callback so a
      // rejected onChunk promise bubbles to a top-level handler we control,
      // not the DataChannel's silent swallow.
      void handle(m).catch((err) => {
        update({ kind: "FAILED", reason: `Sink write failed: ${err?.message ?? err}` });
        teardown();
      });
    };

    const handle = async (m: MessageEvent) => {
      if (cancelled) return;
      if (typeof m.data === "string") {
        try {
          const msg = JSON.parse(m.data);
          if (msg.type === "INIT") {
            // Recompute chunk total in case sender re-segmented.
            chunkTotal = msg.chunkCount;
            update({
              kind: "TRANSFERRING",
              progress: { bytesDone, bytesTotal: opts.meta.size, chunkIndex: 0, chunkTotal },
            });
          } else if (msg.type === "FIN") {
            // Integrity gate: onDone finalizes the sink, which verifies the
            // received bytes' sha256 against the offer. true → DONE; false →
            // MISMATCH (the sink discards the corrupt file).
            const ok = await opts.onDone();
            if (ok) {
              dc.send(JSON.stringify({ type: "DONE", offerId: opts.meta.offerId }));
              update({ kind: "DONE" });
            } else {
              dc.send(JSON.stringify({ type: "MISMATCH", offerId: opts.meta.offerId }));
              update({ kind: "FAILED", reason: "Checksum mismatch" });
            }
            teardown();
          }
        } catch {
          /* ignore malformed JSON */
        }
        return;
      }
      // Binary chunk: [tag][index BE][payload]
      const buf = m.data as ArrayBuffer;
      if (buf.byteLength < 5) return;
      const v = new DataView(buf);
      const tag = v.getUint8(0);
      if (tag !== 0x01) return;
      const idx = v.getUint32(1, false);
      const payload = buf.slice(5);
      if (idx !== nextExpected) {
        // SCTP ordered=true means this shouldn't happen; defensive drop.
        return;
      }
      if (chunkExceedsOffer(idx, payload.byteLength, bytesDone, maxChunkIndex, opts.meta.size)) {
        // The peer is sending more than the offer it made — fail loudly
        // rather than silently keep writing (or silently keep dropping,
        // which would just let it retry forever). See maxChunkIndex above.
        throw new Error("peer sent more data than the offer's negotiated size");
      }
      await opts.onChunk(idx, payload);
      nextExpected += 1;
      bytesDone += payload.byteLength;
      opts.onProgress({
        bytesDone,
        bytesTotal: opts.meta.size,
        chunkIndex: idx,
        chunkTotal,
      });
    };
  };

  offIce = opts.wire.onIce(async (offerId, candidate) => {
    if (offerId !== opts.meta.offerId) return;
    try {
      await pc.addIceCandidate(JSON.parse(candidate));
    } catch {
      /* ignore */
    }
  });

  // Build + send the answer.
  (async () => {
    try {
      await pc.setRemoteDescription({ type: "offer", sdp: opts.offerSdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      opts.wire.sendAnswer(
        opts.peerUserId,
        opts.meta.offerId,
        answer.sdp ?? "",
        opts.resumeFromChunkIndex,
      );
    } catch {
      update({ kind: "FAILED", reason: "Answer creation failed" });
      teardown();
    }
  })().catch(() => {
    update({ kind: "FAILED", reason: "Receiver setup failed" });
    teardown();
  });

  return {
    cancel: () => {
      cancelled = true;
      opts.wire.sendCancel(opts.peerUserId, opts.meta.offerId, "receiver_declined");
      teardown();
      update({ kind: "FAILED", reason: "Cancelled" });
    },
    state: () => state,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Compute SHA-256 of an ArrayBuffer using the WebCrypto subtle API. */
export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Streaming SHA-256 — call .update(buf) for every chunk, then .hex() at the end.
 *  Browser SubtleCrypto doesn't expose an incremental hasher, so we accumulate
 *  via the (somewhat new) `crypto.subtle.digest` over a series of Uint8Arrays
 *  ourselves. For a 10 GB file the memory cost would be unacceptable, so we
 *  use the streaming JS hash from the WICG Web Crypto Streams proposal where
 *  available, otherwise fall back to per-chunk concatenation for files under
 *  ~256 MB (Composer enforces this for the web path).
 *
 *  For the desktop path the renderer hands the file to file-transfer.ts in
 *  main, which does the hash in Node and returns it before the offer is sent.
 *  That keeps the renderer free of large allocations. */
export async function sha256File(file: File): Promise<string> {
  const ab = await file.arrayBuffer();
  return sha256Hex(ab);
}
