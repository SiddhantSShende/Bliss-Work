# 4. Module Documentation

The sections below describe source-visible screens and controls. Since a running UI was unavailable, labels and workflows are **code verified**, not live-UI verified. Fields or rules not established from the source are marked for confirmation.

## 4.1 Authentication, onboarding, and invitations

**Navigation:** signed-out routes `/login`, `/onboarding`, `/invite`, `/forgot-password`, `/reset-password`, `/verify-email`, and `/mfa-challenge`.

**Who uses it:** existing members, invited users, and people creating a workspace. An organization admin can send workspace invitations. The app has separate platform-operator sign-in routes; these are not ordinary user sign-in.

**Controls and fields:** **Email**, **Password**, **Show password**, **Forgot password?**, **Sign in**, CAPTCHA **Security check**, **Refresh security check**, **Create organization**, **Send reset link**, **Update password**, **Confirm your email**, and MFA **Verify**. Invitation acceptance asks for **Username**, **Display name**, and **Password**. Onboarding asks for **Organization name**, **Your name**, **Email**, and **Password**.

**Rules/outcomes:** password policy shown in the UI requires 10 or more characters, a letter, a number, and a special character. Invitation and reset links can expire. MFA accepts an authenticator code or backup code when required. See [Getting started](./02-getting-started.md).

**Errors:** invalid credentials, invalid/expired links, CAPTCHA errors, too many attempts, server failure, or inability to reach the service. See [Troubleshooting](./07-errors-and-troubleshooting.md).

## 4.2 Analytics and dashboard

**Navigation:** **Analytics** (`/app/analytics`); project/channel analytics use `/app/analytics/projects/:projectId` and `/app/analytics/:channelId`. On mobile, the landing page is **Home**.

**Purpose:** show workspace overview and available task/project/channel or member-activity summaries. Analytics may display activity time, events, sessions, application usage, recent activity, trends, or task/project summaries depending on page and data.

**Controls:** overview cards/charts and links into more detailed analytics; date-period controls are visible in activity/report surfaces. Exact default filters and metric definitions require product confirmation.

**Access:** workspace activity and member activity have role-dependent visibility; members can view their own record and admins can view workspace/member activity. Task analytics' complete role matrix is **[To be confirmed]**.

**Empty/error states:** no activity in selected periods can result in empty charts. Retry or change the date range if data cannot load.

## 4.3 Mail

**Navigation:** **Mail** (`/app/mail`); mobile Mail is available from **More** and mail-related chat tabs.

**Mailboxes:** **Inbox**, **Sent**, **Drafts**, **Deleted**, and **Favorites** are represented in the current UI. Use **All** or **Unread** to filter the list and **Check for new mail** to refresh. A person filter can narrow the list.

**Compose fields and controls:** **To**, optional **Cc / Bcc**, **Subject**, **Message**, **Attach**, **Remove all**, **Send**, **Close**, and **Discard**. Recipient addresses can be selected from suggestions or typed. Invalid-looking addresses block sending; subject length is limited, but the exact limit is not specified in this manual. Attachments can be previewed/opened/downloaded; uploads show progress and failure messages.

**Reading and message actions:** open a row to view sender, recipients, body, and attachments. Available actions include **Reply**, **Reply all**, **Forward**, **Download**, **Restore**, delete/remove, and **Add to Favorites** / **Remove from Favorites**. Bcc visibility follows the normal blind-copy behavior described by the UI. Deleting/restoring affects the current user's copy; deleted mail is retained for a limited time according to the UI.

**Drafts:** closing a compose window keeps the draft; **Discard** deletes that draft. A sent or discarded draft may no longer open.

**Errors:** `This mail could not be opened. It may have been removed.`, invalid address, too-long subject, upload failure/size limit, and failed send/restore/delete. Retry after checking connectivity and recipient data.

## 4.4 Chats and messaging

**Navigation:** **Chats** (`/app/chats`). Direct chat details are held in application state; older deep links may use `/app/chats/:conversationId`.

**Purpose:** one-to-one member conversations, with live presence/unread indicators and message history.

**Controls/actions found in source:** start a new chat, compose/send, reply in a thread, react, mark/read status, message actions, search, open profile, forward to a BlissWork chat/channel, and open a call. Attachment, media, location-share, and call controls can appear in conversation context. Message action availability may depend on message type and platform.

**Errors:** an ignored or unavailable conversation may not appear in the list; message or attachment errors should show a retry/failure state. Exact message-size/file-type limits are deployment-dependent or **[To be confirmed]**.

## 4.5 Channels

**Navigation:** **Channels** (`/app/channels`) and `/app/channels/:channelId`.

**Purpose:** group discussion. Channel details can expose members, files, and settings on mobile and channel-related actions on web/desktop.

**Controls/actions:** create channel, open channel, send/reply/react to messages, view members/files, invite/add people, leave, and (for authorized channel moderators) manage members, roles, or blocks. Exact public/private join choices and all moderation controls depend on the channel implementation and permissions; verify in your deployment.

**Roles:** channel owner/admin controls exist in source. Organization admins can have broader management access. A complete role-by-role matrix is **[To be confirmed]**.

**Errors:** unavailable channel, blocked/removed membership, failed member load, or permission errors. Ask a workspace/channel admin if you cannot open a channel or expected controls are missing.

## 4.6 Tasks

**Navigation:** **Tasks** (`/app/tasks` redirects to `/app/tasks/allocated`). The list includes **My tasks**, **Allocated to me**, **Available**, **Completed**, **Left**, **Ignored**, and **Missed** views. Projects are available under the Tasks area.

**Create fields:** **Task Title**, **Description**, **Assign to**, **People**, **Channels**, optional **Deadline**, and allocation timing. The form supports immediate, scheduled, and recurring allocation. Schedule controls include start date/time, repeat interval/type, weekdays/monthly rule, occurrence count/end date, and deadline settings. The exact controls depend on the chosen allocation mode.

**Actions:** **New task**, **Create Task**, **Acknowledge**, **Ignore**, **Complete**, **Leave**, **Pin task / Unpin task**, participant add/withdraw, **Reassign**, and review actions such as **Write review** or **Edit review**. Some actions are available only in the matching task state.

**Validation:** a task needs a title and at least one recipient; a selected project/channel/recipient must be valid. Schedule and deadline dates/times must be valid and in the future where required. Invalid recurring weekdays, date ranges, occurrence counts, or deadlines produce validation messages.

**State:** tasks can be allocated, acknowledged, ignored, completed, left, missed, and reviewed. A deadline passing before completion can move a task to **Missed**. Allocators can review completed work. Reassignment and participant management have state/permission constraints.

**Mobile difference:** the inspected mobile assignment form provides title, description, and assignee selection; it does not show priority or due-date fields.

## 4.7 Projects

**Navigation:** project lists/workspaces are within Tasks; project route is `/app/tasks/projects/:projectId`.

**Create fields:** **Project Name** and one or more **Channels**. The UI says a project channel must have at least two members. Project completion is a separate action and can be irreversible; the confirmation says a completed project cannot be reopened.

**Actions:** create project, open linked project channel, view tasks created/assigned, and **Complete Project** after confirmation. Empty projects display a no-tasks state. Project lookup or channel membership sync may fail; retry or contact an admin if the task was saved but channel membership was not updated.

## 4.8 Meetings and calls

**Navigation:** **Meetings** (`/app/meetings`) provides a calendar/list and meeting details (`/app/meetings/:callId`). Live call windows use `/call/:callId`; invite links use `/join`.

**Scheduling:** the meeting form includes title, audio/video mode, date/time, duration, invited people/channels, and schedule/repeat options where available. Exact field validation and availability depend on the selected form and client.

**Call controls:** call UI can provide microphone mute, camera, screen share, participants, chat, notes, invite/add people, picture-in-picture, minimize, and end-call controls. **End for everyone** is distinct from leaving where shown. Recording is deployment/browser dependent and is not guaranteed available.

**Join behavior:** invalid/expired/revoked links, ended meetings, lack of roster access, missing camera/microphone permission, and connection timeouts are represented in source. Ask the organizer for a valid invite if a link is expired or revoked.

## 4.9 Members and organization

**Members navigation:** **Members** (`/app/members`), workspace activity (`/app/members/activity`), and member detail (`/app/members/:userId`).

**Directory:** search teammates; member rows can show presence/last-seen state and a message action.

**Member detail tabs:** **Overview**, **Activity**, **Analytics**, **Sessions**, **Admin**, and **Security**. The member profile can show email, username, role, status, email verification, joined/removed dates, and last-seen information. The source also contains audit-log event labels for workspace/member actions; the exact visible location and filters need confirmation. Admin actions in source include **Make admin**, **Demote to member**, **Suspend**, **Remove**, **Reactivate**, and signing out a member session. These controls are permission-gated; the exact live availability must be verified.

**Organization:** **Org** (`/app/org`) includes organization/membership views and a leave-workspace action. Leaving can be restricted if it is the only workspace or the last administrator. Some lifecycle actions are destructive and require confirmation/step-up.

**Invitations:** on web, `/app/invite` shows **Invite teammates**, email, role, **Send**, pending invitation list, and revoke controls. The UI says invitations are admins-only. On desktop, that route redirects to Mail. Mobile exposes a Members area; invite controls may not be present there.

**Workspace security and deletion:** organization admins can choose **Require two-factor authentication for admins** (**Turn on** / **Turn off**). Enabling it starts a grace period; unenrolled admins are warned and are later required to enroll at sign-in. In the **Danger zone**, **Delete this workspace…** requires typing the exact workspace identifier before **Delete workspace** is enabled. Everyone is signed out immediately; workspace messages, files, tasks, and activity are scheduled for permanent deletion after a grace period. An admin can use **Cancel deletion** before the displayed deadline. Confirm all consequences and consult the administrator before proceeding.

## 4.10 Activity and analytics records

**Navigation:** admins can use Members > **Workspace activity** and member detail tabs; users can find their own record through Settings > activity or mobile **My Activity**.

**Visible report content:** activity overview, active/idle time, sessions, recorded events/actions, recent activity, top applications, trend charts, and session information may appear, depending on deployment data and permissions.

**Privacy/access:** repository documentation states that users can read their own activity record and organization admins can read other members' records and org-wide views. Activity data has multiple sources, including service events and client/device reports; consult the organization policy before treating client-reported detail as authoritative.

**Export:** **Export** / **Export .xlsx** can generate activity workbooks with Summary, Daily, and Sessions sheets. Date filters use the user's local time zone according to the UI. See [Reports and exports](./06-reports-and-exports.md).

## 4.11 Account, profile, and settings

**Profile:** `/app/profile` / **Edit profile**. Fields include **Display name**, **Email**, and **Username**; email/username are read-only in the observed code. **Change photo** accepts JPG, PNG, or WebP; unsupported types or failed image processing show errors. **Save changes** saves profile edits.

**Settings:** `/app/settings` includes appearance/theme and notification-related settings. The About area can show a build/version identifier and desktop update actions when the host provides them. The exact toggles and preference labels are not fully catalogued here and need live-screen confirmation.

**Security:** `/app/settings/security` provides MFA enrollment/status, backup-code regeneration, disable actions, and password change. Sensitive actions can ask for a password, authenticator code, or backup code.

**Active sessions:** `/app/settings/sessions` lists signed-in devices and offers **Sign out** and **Sign out of all other sessions**. Confirm before revoking; the device must sign in again.

## 4.12 Billing and platform pricing

**Organization billing:** `/app/settings/billing` displays **Credits & Billing**, balance, monthly cost per member, credit packages, and transaction history when billing is configured. Source UI says only organization admins can view it. If billing is not set up, a **Billing unavailable** message appears. Purchase/checkout actions may depend on configuration and are not confirmed as generally available.

**Platform pricing:** `/app/operator/pricing` is an unlinked, platform-operator-only route for global pricing and credit-package catalog management. It is not a normal workspace user feature. Do not attempt to access it unless explicitly authorized as a platform operator.

The separate `/super-admin/login` and `/super-admin/dashboard` routes are platform-operator surfaces outside ordinary workspace sign-in. They are not user self-service screens and are not covered as an operational procedure here.

## 4.13 Task stickies

**Web:** browser stickies may appear over authenticated app pages for pinned tasks. Source includes pin/unpin, drag/reposition, and collapse/expand controls. Local position persistence is code evidence; cross-device synchronization is not confirmed.

**Desktop:** Electron has native sticky task windows. Exact OS-level behavior, note limits, and supported interactions should be confirmed against the installed version; existing documentation describes a five-note cap, but this needs a current release check.

**Mobile:** no equivalent desktop-style sticky overlay was established.

## 4.14 Integrations, attachments, and previews

**User-facing integrations:** a connected-account integration settings screen was not found in the current main navigation. The backend has provider-connection/OAuth and credential APIs, but availability and UI exposure are deployment-dependent. Do not assume Slack, Gmail, or Microsoft Teams account linking is available.

**External forwarding:** chat message actions include a WhatsApp forwarding handoff in source. It opens WhatsApp with text prepared; it is not proof that a message was delivered. Attachment forwarding through this handoff is not established.

**Attachments and previews:** chat/mail/channel attachment handling and file viewing are present. Office-document preview depends on an optional conversion service; if unavailable, use the available download/open action. Exact file-size and file-type limits are **[To be confirmed]**.

## 4.15 Mobile client

**Navigation:** Home, Chats, Tasks, Meetings, and More bottom tabs. More contains additional workspace/account sections. The mobile client has separate screen implementations; compare labels and actions with [Feature inventory](./FEATURE-INVENTORY.md).

**Mobile-specific verified code paths:** sign-in/MFA; home dashboard and recent task/member sheets; chat and channel screens; task list/detail/create/assign; meeting scheduling/detail/call overlays; mail list/detail/compose; members, profile, org switcher, activity, MFA, sessions, and settings. Device permissions may be required for camera, microphone, location sharing, notifications, file selection, and screen security.

The mobile **Settings** screen includes notification/privacy controls, **Your activity**, **Help & Support > Contact**, and **About BlissWork** entry points. The support link's target is awaiting owner confirmation.

**Not established:** exact minimum Android/iOS versions, all administrative controls, feature parity with web/desktop, and runtime permission prompts.
