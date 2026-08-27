/**
 * The options page: connect, pause, disconnect, and see the current state.
 *
 * It is also the extension's honesty surface. Someone who installed this — or
 * had it installed for them — should be able to open it and get a straight
 * answer to "is this recording right now, and what does it send". Everything it
 * claims on screen is enforced in tracker.ts, not just described here.
 */
import { provisionToken } from "./provisioning";

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

async function state() {
  return chrome.storage.local.get(["token", "apiBase", "paused"]) as Promise<{
    token?: string;
    apiBase?: string;
    paused?: boolean;
  }>;
}

async function render(): Promise<void> {
  const { token, apiBase, paused } = await state();
  const connected = !!token;
  $("setup").hidden = connected;
  $("connected").hidden = !connected;
  ($("pause") as HTMLButtonElement).textContent = paused ? "Resume" : "Pause";

  const status = $("status");
  if (!connected) {
    status.textContent = "Not connected. Nothing is being recorded.";
  } else if (paused) {
    status.innerHTML = "<strong>Paused.</strong> Nothing is being recorded.";
  } else {
    const host = safeHost(apiBase);
    status.innerHTML = `<strong>Recording</strong> to ${host}. Pause any time.`;
  }
}

function safeHost(base: string | undefined): string {
  try {
    return new URL(base ?? "").host || "your workspace";
  } catch {
    return "your workspace";
  }
}

/** Accepts a bare origin or a full API base and normalises to the API root. */
function normaliseBase(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  // Refuse plaintext to anything but a developer's own machine: a connection
  // code travelling over http:// on a shared network is a credential anyone on
  // that network can take.
  const localhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !localhost) return null;
  if (url.pathname.includes("/api/telemetry")) return url.origin + "/api/telemetry";
  return `${url.origin}/api/telemetry`;
}

async function notifyWorker(): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: "config-changed" });
  } catch {
    // The worker may be asleep; it re-reads storage on its next wake anyway.
  }
}

$("connect").addEventListener("click", async () => {
  const token = ($("token") as HTMLInputElement).value.trim();
  const base = normaliseBase(($("base") as HTMLInputElement).value);
  const status = $("status");
  if (!token) {
    status.textContent = "Paste the connection code from BlissWork first.";
    return;
  }
  if (!base) {
    status.textContent = "That address doesn't look right — it must start with https://";
    return;
  }

  ($("connect") as HTMLButtonElement).disabled = true;
  status.textContent = "Checking…";
  try {
    const result = await provisionToken(token, base);
    if (!result.ok) {
      status.textContent =
        result.reason === "invalid-token"
          ? "That connection code isn't valid — generate a new one in BlissWork."
          : "Couldn't reach that address. Check it and try again.";
      return;
    }
    ($("token") as HTMLInputElement).value = "";
    await notifyWorker();
    await render();
  } finally {
    ($("connect") as HTMLButtonElement).disabled = false;
  }
});

$("pause").addEventListener("click", async () => {
  const { paused } = await state();
  await chrome.storage.local.set({ paused: !paused });
  await notifyWorker();
  await render();
});

$("disconnect").addEventListener("click", async () => {
  await chrome.storage.local.remove(["token", "apiBase", "paused"]);
  await chrome.storage.session.remove(["queue", "open"]);
  await notifyWorker();
  await render();
});

void render();
