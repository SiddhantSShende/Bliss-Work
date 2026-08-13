/**
 * Phase 10 file-transfer coordinator.
 *
 * Binds the rtcTransfer.ts sender/receiver state machines to the rtc.*
 * signaling channel, tracks per-offer TransferState, and exposes a tiny API to
 * the thread UI (send / accept / decline / cancel / stateOf).
 *
 * Transport-agnostic via useRuntime().rtc: web signals over the renderer's own
 * WsClient; Electron over the ws-process through the config.rtc IPC bridge. The
 * attach UI is gated on rtcAvailable, true on both platforms.
 *
 * Receiver sink is an in-memory Blob → browser download. Fine for normal files;
 * a desktop disk-backed sink (for the 10 GB extreme) is a further optimization.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRuntime } from "./runtime";
import { useSession } from "../store/session";
import { encodeFileOffer, type FileOfferEnvelope } from "./fileOffer";
import type { FileSink } from "../platform";
import {
  startReceiverTransfer,
  startSenderTransfer,
  sha256File,
  sha256Hex,
  type FileOfferMeta,
  type ReceiverHandle,
  type ReceiverWire,
  type SenderHandle,
  type SenderWire,
  type TransferState,
} from "./rtcTransfer";

type CancelReason = "sender_left" | "receiver_declined" | "ice_failed" | "timeout";

export interface FileTransferApi {
  /** True when running where rtc signaling is reachable (web renderer). */
  available: boolean;
  /** Hash + announce a file into a thread, then start the sender state machine. */
  send: (file: File, threadId: string, peerUserId: string) => Promise<void>;
  /** Accept an incoming offer (from its thread-message envelope). */
  accept: (env: FileOfferEnvelope) => void;
  /** Decline an incoming offer — tells the sender so its bubble can settle. */
  decline: (env: FileOfferEnvelope, fromUserId: string) => void;
  /** Cancel an in-flight transfer we own (sender or accepted receiver). */
  cancel: (offerId: string) => void;
  stateOf: (offerId: string) => TransferState | undefined;
}

const Ctx = createContext<FileTransferApi | null>(null);

interface BufferedOffer {
  fromUserId: string;
  sdp: string;
}

export function FileTransferProvider({ children }: { children: React.ReactNode }) {
  const { rtc, rtcAvailable, api, config } = useRuntime();
  const me = useSession((s) => s.user);
  const available = rtcAvailable && !!me;

  const [states, setStates] = useState<Record<string, TransferState>>({});
  const setState = useCallback(
    (offerId: string, s: TransferState) => setStates((prev) => ({ ...prev, [offerId]: s })),
    [],
  );

  const handles = useRef(new Map<string, SenderHandle | ReceiverHandle>());
  const incoming = useRef(new Map<string, BufferedOffer>());
  const pendingAccepts = useRef(new Map<string, FileOfferEnvelope>());

  const senderWire = useMemo<SenderWire>(
    () => ({
      sendOffer: (to, offerId, sdp) => rtc.sendFrame({ type: "rtc.offer", toUserId: to, offerId, sdp }),
      sendIce: (to, offerId, candidate) => rtc.sendFrame({ type: "rtc.ice", toUserId: to, offerId, candidate }),
      sendCancel: (to, offerId, reason) =>
        rtc.sendFrame({ type: "rtc.cancel", toUserId: to, offerId, reason: reason as CancelReason }),
      onAnswer: (cb) =>
        rtc.onControl((f) => {
          if (f.type === "rtc.answer") cb(f.offerId, f.sdp, f.resumeFromChunkIndex);
        }),
      onIce: (cb) =>
        rtc.onControl((f) => {
          if (f.type === "rtc.ice") cb(f.offerId, f.candidate);
        }),
      onUnreachable: (cb) =>
        rtc.onControl((f) => {
          if (f.type === "rtc.peer.unreachable") cb(f.offerId);
        }),
    }),
    [rtc],
  );

  const receiverWire = useMemo<ReceiverWire>(
    () => ({
      sendAnswer: (to, offerId, sdp, resume) =>
        rtc.sendFrame({ type: "rtc.answer", toUserId: to, offerId, sdp, resumeFromChunkIndex: resume }),
      sendIce: (to, offerId, candidate) => rtc.sendFrame({ type: "rtc.ice", toUserId: to, offerId, candidate }),
      sendCancel: (to, offerId, reason) =>
        rtc.sendFrame({ type: "rtc.cancel", toUserId: to, offerId, reason: reason as CancelReason }),
      onIce: (cb) =>
        rtc.onControl((f) => {
          if (f.type === "rtc.ice") cb(f.offerId, f.candidate);
        }),
    }),
    [rtc],
  );

  // Web buffers in memory + downloads; Electron streams to disk (config.fileSink),
  // so a multi-GB transfer never has to fit in renderer memory.
  const sink = useMemo<FileSink>(() => config.fileSink ?? createMemorySink(), [config.fileSink]);

  const startReceive = useCallback(
    async (env: FileOfferEnvelope, fromUserId: string, sdp: string) => {
      await sink.open(env.offerId, env.name, env.size);
      const meta: FileOfferMeta = {
        offerId: env.offerId,
        name: env.name,
        size: env.size,
        sha256: env.sha256,
        mimeType: env.mime,
      };
      const handle = startReceiverTransfer({
        meta,
        peerUserId: fromUserId,
        wire: receiverWire,
        offerSdp: sdp,
        onProgress: () => {},
        onState: (s) => {
          setState(env.offerId, s);
          if (s.kind === "FAILED") sink.abort(env.offerId);
        },
        onChunk: async (_i, payload) => {
          await sink.write(env.offerId, payload);
        },
        onDone: () => sink.finish(env.offerId, env.sha256),
      });
      handles.current.set(env.offerId, handle);
    },
    [sink, receiverWire, setState],
  );

  // Buffer inbound rtc.offer SDPs (so a later Accept has them); honor a
  // pending Accept that beat the SDP; reflect peer-side cancels.
  useEffect(() => {
    if (!available) return;
    return rtc.onControl((f) => {
      if (f.type === "rtc.offer") {
        incoming.current.set(f.offerId, { fromUserId: f.fromUserId, sdp: f.sdp });
        const pend = pendingAccepts.current.get(f.offerId);
        if (pend) {
          pendingAccepts.current.delete(f.offerId);
          void startReceive(pend, f.fromUserId, f.sdp);
        }
      } else if (f.type === "rtc.cancel") {
        setState(f.offerId, { kind: "FAILED", reason: "Cancelled by peer" });
        incoming.current.delete(f.offerId);
        pendingAccepts.current.delete(f.offerId);
      }
    });
  }, [rtc, available, startReceive, setState]);

  const send = useCallback(
    async (file: File, threadId: string, peerUserId: string) => {
      if (!available) return;
      const offerId = crypto.randomUUID();
      setState(offerId, { kind: "OFFERED" });
      // Desktop streams the hash Node-side (no full-file load); web hashes in memory.
      const sha256 = config.hashFile ? await config.hashFile(file) : await sha256File(file);
      const mime = file.type || "application/octet-stream";
      // 1. Announce as a thread message so both peers get a bubble.
      await api
        .replyToThread(threadId, encodeFileOffer({ offerId, name: file.name, size: file.size, sha256, mime }), {
          clientMsgId: crypto.randomUUID(),
        })
        .catch(() => {});
      // 2. Start the sender state machine (opens the RTCPeerConnection, sends rtc.offer).
      const handle = startSenderTransfer({
        file,
        meta: { offerId, name: file.name, size: file.size, sha256, mimeType: mime },
        peerUserId,
        wire: senderWire,
        onProgress: () => {},
        onState: (s) => setState(offerId, s),
      });
      handles.current.set(offerId, handle);
    },
    [available, api, senderWire, setState, config],
  );

  const accept = useCallback(
    (env: FileOfferEnvelope) => {
      if (!available) return;
      setState(env.offerId, { kind: "CONNECTING" });
      const buffered = incoming.current.get(env.offerId);
      if (buffered) void startReceive(env, buffered.fromUserId, buffered.sdp);
      else pendingAccepts.current.set(env.offerId, env); // SDP will arrive shortly
    },
    [available, startReceive, setState],
  );

  const decline = useCallback(
    (env: FileOfferEnvelope, fromUserId: string) => {
      receiverWire.sendCancel(fromUserId, env.offerId, "receiver_declined");
      setState(env.offerId, { kind: "FAILED", reason: "Declined" });
      incoming.current.delete(env.offerId);
      pendingAccepts.current.delete(env.offerId);
    },
    [receiverWire, setState],
  );

  const cancel = useCallback(
    (offerId: string) => {
      handles.current.get(offerId)?.cancel();
      handles.current.delete(offerId);
      sink.abort(offerId);
    },
    [sink],
  );

  const value = useMemo<FileTransferApi>(
    () => ({ available, send, accept, decline, cancel, stateOf: (id) => states[id] }),
    [available, send, accept, decline, cancel, states],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFileTransfers(): FileTransferApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useFileTransfers used outside FileTransferProvider");
  return v;
}

/** Default web sink: buffer chunks in memory, then trigger a browser download. */
function createMemorySink(): FileSink {
  const bufs = new Map<string, { name: string; chunks: ArrayBuffer[] }>();
  return {
    async open(id, name) {
      bufs.set(id, { name, chunks: [] });
    },
    async write(id, data) {
      bufs.get(id)?.chunks.push(data);
    },
    async finish(id, expected) {
      const b = bufs.get(id);
      bufs.delete(id);
      if (!b) return false;
      const blob = new Blob(b.chunks);
      const digest = await sha256Hex(await blob.arrayBuffer());
      if (digest !== expected) return false; // corrupt — don't hand the file over
      await downloadBlob(blob, b.name);
      return true;
    },
    abort(id) {
      bufs.delete(id);
    },
  };
}

function downloadBlob(blob: Blob, name: string): Promise<void> {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return Promise.resolve();
}
