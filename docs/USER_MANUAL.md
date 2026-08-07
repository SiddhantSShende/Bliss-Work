# BlissWork (Task-Board) — Official User Manual

Welcome to **BlissWork** (Task-Board), a unified team collaboration platform designed for frictionless real-time messaging, task allocation, cross-platform mention tracking, WebRTC calling, and desktop productivity sticky notes.

BlissWork is available both as a modern Web application and as an Electron Desktop application with native OS-level desktop sticky widgets.

---

## Table of Contents
1. [Getting Started](#1-getting-started)
   - [System Requirements & Quick Access](#system-requirements--quick-access)
   - [Account Registration & Login](#account-registration--login)
   - [Multi-Organization Navigation](#multi-organization-navigation)
2. [Unified Inbox & Real-Time Messaging](#2-unified-inbox--real-time-messaging)
   - [1:1 Direct Messages (DMs)](#11-direct-messages-dms)
   - [Team Channels & Discussions](#team-channels--discussions)
   - [Media, File Attachments & WebRTC Calls](#media-file-attachments--webrtc-calls)
3. [Task Allocation & Workflow Lifecycle](#3-task-allocation--workflow-lifecycle)
   - [Creating & Assigning Tasks](#creating--assigning-tasks)
   - [Task Actions: Acknowledge, Ignore, Complete & Leave](#task-actions-acknowledge-ignore-complete--leave)
   - [Task Timelines & Allocator Performance Reviews](#task-timelines--allocator-performance-reviews)
   - [Exporting Task Log to Excel (.xlsx)](#exporting-task-log-to-excel-xlsx)
4. [Desktop Sticky Notes & Browser Overlay](#4-desktop-sticky-notes--browser-overlay)
   - [Electron Desktop Stickies](#electron-desktop-stickies)
   - [In-Browser Floating Notes](#in-browser-floating-notes)
5. [External Integrations & Hub Mentions](#5-external-integrations--hub-mentions)
   - [Connecting External Apps (Slack, WhatsApp, Gmail, Outlook, Teams)](#connecting-external-apps-slack-whatsapp-gmail-outlook-teams)
   - [Setting Up Webhooks & WhatsApp Verification](#setting-up-webhooks--whatsapp-verification)
   - [Hub Mentions & Claiming Mentions as Tasks](#hub-mentions--claiming-mentions-as-tasks)
   - [Mapping External Handles](#mapping-external-handles)
6. [Organization & Account Administration](#6-organization--account-administration)
   - [Inviting & Managing Members](#inviting--managing-members)
   - [Profile & Security Settings](#profile--security-settings)
7. [Keyboard Shortcuts & Quick Reference](#7-keyboard-shortcuts--quick-reference)

---

## 1. Getting Started

### System Requirements & Quick Access

BlissWork can be accessed via any web browser or through the dedicated Electron desktop application:

* **Web Application:** Access via your web browser (Default local URL: `http://localhost:5173`). Supported on Chrome, Edge, Firefox, and Safari.
* **Electron Desktop Application:** Native application available for Windows (`.exe`), Linux (`AppImage`/`.deb`), and macOS. Provides always-on-top desktop sticky widgets that sit behind open application windows.

### Account Registration & Login

1. Navigate to the login page.
2. Enter your email address and password.
3. If joining via an invitation link, click the link sent to your email to confirm registration and join the designated workspace.

> [!NOTE]
> Demo environments pre-seed default organization credentials (`acme` workspace with users `alice`, `bob`, `carol` and password `Passw0rd!`).

### Multi-Organization Navigation

BlissWork allows a single user account to belong to multiple organizations seamlessly.

* **Switching Workspaces:** Use the top bar Organization Switcher dropdown menu located at the top left of the screen to switch between active organizations instantly without re-authenticating.
* **Organization Details:** View organization statistics, members, and custom settings under the **Org** menu tab (`/app/org`).

---

## 2. Unified Inbox & Real-Time Messaging

### 1:1 Direct Messages (DMs)

The **Chats** section (`/app/chats`) provides direct 1:1 communication between workspace members:

* **Starting a Conversation:** Click **New Chat** (+ icon), select a user from the organization directory, and send your message.
* **Accept / Ignore Request:** When receiving a new DM from someone you haven't messaged before:
  * Click **Reply** to accept the thread and continue chatting.
  * Click **Ignore** to dismiss the conversation from your active view.
* **Live Presence & Typing Indicators:** See real-time online status indicators and typing indicators as counterparties compose messages.
* **Read Receipts:** Track message delivery and read status per message.

### Team Channels & Discussions

Channels (`/app/channels`) enable topic-driven or department-wide group discussions:

* **Create Channel:** Click **+ New Channel**, specify a channel name (e.g., `#engineering`, `#announcements`), and optional topic description.
* **Public vs Private:** Join open public channels or get invited to private team channels.
* **Message Threading & Forwarding:** Reply directly within message threads or forward critical updates to other channels or members.

### Media, File Attachments & WebRTC Calls

* **File Transfers:** Share images, videos, audio notes, locations, and documents directly within chat windows.
  * *P2P Desktop Transfers:* Large files stream directly to disk without cloud storage limits.
* **1:1 Audio & Video Calls:**
  * Click the **Phone** or **Video** icon inside any 1:1 DM window to initiate a WebRTC call.
  * Adjust microphone mute (`Mic`), camera toggle (`Video`), or end the call (`Hang up`) using the call bar controls.

---

## 3. Task Allocation & Workflow Lifecycle

Task management in BlissWork follows an explicit, accountable state machine designed to ensure clarity between task allocators and assignees.

```
                  ┌──────────────┐
                  │   CREATED    │
                  └──────┬───────┘
                         │
                 (Task Assigned)
                         │
                         ▼
                  ┌──────────────┐
       ┌──────────┤  ALLOCATED   ├──────────┐
       │          └──────┬───────┘          │
       │                 │                  │
(Recipient       (Recipient         (Recipient
 Ignores)         Acknowledges)      Ignores)
       │                 │                  │
       ▼                 ▼                  ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│   IGNORED    │  │ ACKNOWLEDGED │  │   IGNORED    │
└──────────────┘  └──────┬───────┘  └──────────────┘
                         │
            ┌────────────┴────────────┐
            │                         │
    (Assignee Completes)      (Assignee Leaves)
            │                         │
            ▼                         ▼
     ┌──────────────┐          ┌──────────────┐
     │  COMPLETED   │          │     LEFT     │
     └──────┬───────┘          └──────────────┘
            │
    (Allocator Reviews)
            │
            ▼
     ┌──────────────┐
     │   REVIEWED   │
     └──────────────┘
```

### Creating & Assigning Tasks

1. Navigate to **Tasks** (`/app/tasks/allocated`) or click **New Task** (+ icon).
2. Enter the **Task Title** and detailed **Description**.
3. Select one or multiple assignees from your workspace members.
4. Click **Create Task**. The task is instantly dispatched to each assignee's inbox and sticky note overlay.

### Task Actions: Acknowledge, Ignore, Complete & Leave

Assignees interact with tasks through clear action buttons:

* **Acknowledge:** Confirms receipt and acceptance of the task. 
  * Notifies the allocator that work has commenced.
  * Locks the task into your active task list and floats it as a sticky note.
* **Ignore:** Declines the task.
  * Notifies the allocator that the task was ignored.
  * Removes the task from your actionable inbox.
* **Complete:** Marks an acknowledged task as completed upon finishing the work.
  * Notifies the allocator immediately.
  * Unlocks the review phase for the task sender.
* **Leave:** Allows an assignee to drop an acknowledged task if priorities change.
  * Moves the task into the **Left** category and alerts the sender.

### Task Timelines & Allocator Performance Reviews

Task senders can track real-time progress under **Tasks > My Tasks** (`/app/tasks/mine`):

* **Chronological Milestones:** View detailed timestamps for when the task was *Allocated*, *Acknowledged*, *Completed*, or *Left*.
* **Writing Reviews:** Once an assignee completes a task, the allocator can click **Write Review**:
  * Provide a **Star Rating (1 to 5 stars)**.
  * Add detailed feedback comments to document performance quality.

### Exporting Task Log to Excel (.xlsx)

Export full task timeline records for reporting or auditing:

1. Click the **Export** button in the top header of the Tasks view.
2. Choose **Which tasks** to export:
   * *All my tasks*
   * *Allocated by me*
   * *Assigned to me*
3. Select a **Time range**: *Past week*, *Past month*, *Past year*, *All time*, or set a *Custom range*.
4. Click **Export**. The application generates a `.xlsx` spreadsheet containing task titles, assignees, emails, local timestamps, statuses, and performance ratings.

---

## 4. Desktop Sticky Notes & Browser Overlay

BlissWork brings actionable tasks front-and-center using sticky notes so critical work items are never forgotten.

### Electron Desktop Stickies

When using the desktop app, assigned and acknowledged tasks pin directly to your operating system desktop as frameless widgets:

* **Sit Behind Applications:** Desktop stickies stay anchored behind active application windows, visible whenever you show your desktop.
* **Inline Actions:** Perform **Acknowledge**, **Ignore**, or **Unpin** directly from the desktop sticky note.
* **Pin Cap:** Desktop supports up to 5 pinned sticky notes simultaneously.

### In-Browser Floating Notes

When using the Web version, floating sticky notes render directly inside the browser viewport:

* **Drag & Move:** Click and drag notes anywhere on screen. Position preference is saved locally.
* **Collapse / Expand:** Click the **Minus (-)** icon to minimize a sticky into a small pill widget, or **Maximize** to expand.
* **Unpin / Dismiss:** Click **Unpin** to remove the sticky overlay while retaining the task in your main Tasks list.

---

## 5. External Integrations & Hub Mentions

BlissWork connects with external workplace tools (Slack, WhatsApp, Gmail, Outlook, Microsoft Teams) to consolidate notifications and action items into a single dashboard.

### Connecting External Apps (Slack, WhatsApp, Gmail, Outlook, Teams)

Navigate to **Integrations** (`/app/integrations`) to link accounts:

| Provider | Method | Credentials Required |
|---|---|---|
| **Slack** | Token / Webhook | Bot Token (`xoxb-…`), Signing Secret |
| **WhatsApp** | One-click signup (**Business accounts only**) | None — sign in to your WhatsApp Business account. *(Advanced/manual: System-user Token, Business Account ID, Phone Number ID, App Secret)* |
| **Gmail** | OAuth 2.0 | Google Account Sign-In |
| **Outlook** | OAuth 2.0 | Microsoft Account Sign-In |
| **Microsoft Teams** | OAuth 2.0 | Microsoft Account Sign-In |

### Setting Up Webhooks & Finishing a WhatsApp Connection

1. **Webhook URL:** After connecting a provider (e.g. Slack or WhatsApp), expand **Show Webhook Setup** on the connection card and copy the generated Webhook URL and Verification Token into the provider's developer dashboard.
2. **WhatsApp — Business accounts only, and normally one click.** Choose **Connect WhatsApp Business**, sign in to the Meta Business account that owns your number, and pick the number. No developer app, no tokens, no IDs, no webhook to paste. WhatsApp connects a *business* number, never a personal WhatsApp account.
3. **Connecting manually (advanced).** Only needed if one-click signup isn't available on your deployment. Your system-user token then needs both `whatsapp_business_messaging` and `whatsapp_business_management`, and BlissWork checks with Meta that the Business Account is approved and the number is verified and belongs to it before saving anything. The connection shows as **Waiting for Meta** until you paste its Webhook URL and Verify Token into **WhatsApp → Configuration → Webhook → Edit** and subscribe to `messages`; it turns **Connected** by itself the moment Meta calls.

### Hub Mentions & Claiming Mentions as Tasks

BlissWork deliberately filters out bulk noise (`@here`, `@channel`, marketing mail) and surfaces **ONLY direct `@mentions` targeting you** across connected platforms under **Mentions** (`/app/integrations`):

* **Claim as Task:** Click **Claim** on any mention to instantly turn it into an internal BlissWork task allocated to yourself.
* **Ignore Mention:** Click **Ignore** to dismiss the mention.

### Mapping External Handles

To ensure BlissWork recognizes external `@mentions` as belonging to you:

1. Scroll to **My Handles** on the Integrations page.
2. Click **+ Add handle**.
3. Select the platform (e.g., Slack, WhatsApp, Gmail) and enter your exact handle ID or email address.

---

## 6. Organization & Account Administration

### Inviting & Managing Members

Admins and team members can manage workspace users from **Members** (`/app/members`) and **Org** (`/app/org`):

* **Invite Member:** Click **Invite**, enter the recipient's email address, and send an invitation link.
* **Invite List:** Track pending invites and copy shareable invitation links.
* **Roles:** Manage permissions (Admin vs Member).

### Profile & Security Settings

Navigate to **Settings** (`/app/settings`) or click your profile avatar:

* **Update Profile:** Edit display name, title, and avatar.
* **Password Change:** Update authentication credentials securely.
* **Active Sessions:** View and revoke active JWT session tokens.

---

## 7. Keyboard Shortcuts & Quick Reference

| Shortcut | Action |
|---|---|
| `Esc` | Close active dialog or modal window |
| `Enter` | Send message in chat / Confirm dialog action |
| `Shift + Enter` | Insert new line in message composer |

---

> [!TIP]
> For infrastructure setup, self-hosting details, or API key configuration, please refer to [`README.md`](file:///home/ubuntu/BlissWork/Bliss-Work/README.md) and [`docs/INTEGRATIONS-SETUP.md`](file:///home/ubuntu/BlissWork/Bliss-Work/docs/INTEGRATIONS-SETUP.md).
