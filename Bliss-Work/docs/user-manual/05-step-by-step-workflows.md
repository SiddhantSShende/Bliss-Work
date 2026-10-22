# 5. Step-by-Step Workflows

These steps reflect source-visible flows. Check that the relevant controls are available to your role before starting.

## 5.1 Create and assign a task

**Prerequisites:** sign in to the correct workspace; identify at least one person or channel to receive the task.

1. Open **Tasks** and choose **New task**.
2. Enter **Task Title** and add a **Description** if needed.
3. Under **Assign to**, choose one or more people and/or channels.
4. Optionally set a deadline or choose an immediate, scheduled, or recurring allocation.
5. Review the recipients and timing, then select **Create Task**.

**Expected result:** the task appears in the task views appropriate to the allocator and recipients. Scheduled tasks appear at the selected time. A missing title/recipient or invalid date produces an error and prevents creation.

## 5.2 Respond to an assigned task

1. Open **Tasks > Allocated to me** or **Available**.
2. Open the task and read its description and deadline.
3. Choose **Acknowledge** to accept it or **Ignore** to decline it.
4. Once acknowledged, use **Complete** when finished, or **Leave** if you must stop participating.

**Expected result:** the task moves into the corresponding state view and the allocator is notified of relevant changes. Actions are state-dependent; if a button is not available, refresh the task or ask the allocator.

## 5.3 Review a completed task

1. Open **Tasks > My tasks** or the task list where you allocated the work.
2. Open the completed item and review its timeline.
3. Choose **Write review** (or **Edit review** if one exists).
4. Provide a rating and feedback if those fields are shown, then save.

Rating range and exact feedback field validation should be confirmed in the live UI.

## 5.4 Search, filter, and page through tasks

1. Use the top-bar search to find people, channels, chats, or tasks.
2. Open **Tasks** and choose a category such as **My tasks**, **Allocated to me**, or **Missed**.
3. Use the available task filter/search controls, including people/channels where shown.
4. Use **Previous**, **Next**, or **Load more** to navigate additional results.
5. Clear filters when the expected task is not shown.

Search does not imply that every module (for example, Mail) is included.

## 5.5 Create a project

1. Open **Tasks** and choose the project creation action.
2. Enter **Project Name**.
3. Select one or more eligible channels. The UI requires at least one channel and says a project channel needs at least two members.
4. Select **Create Project**.
5. Open the project to view its tasks or linked channel.

Use **Complete Project** only when the project is finished. The confirmation warns that completion cannot be reversed.

## 5.6 Send and manage Mail

1. Open **Mail** and select **New Mail**.
2. Enter one or more **To** recipients. Use **Cc / Bcc** if needed.
3. Enter **Subject** and **Message**.
4. Optionally select **Attach** and wait for upload completion.
5. Select **Send**.

To reply, use **Reply** or **Reply all** on the message. To forward, choose **Forward**. To preserve an unfinished composition, close it so it remains a draft; use **Discard** only when you intend to delete it.

If **Send** is unavailable, correct invalid recipient addresses, shorten an overlong subject, or resolve attachment failures.

## 5.7 Add an attachment and download/open it

1. In a chat or mail composer, choose the attachment control (for example **Attach** or the paperclip).
2. Select the file using the system file picker.
3. Confirm that the file appears in the attachment tray and wait for upload completion.
4. Send the message when ready.
5. To retrieve a received attachment, open the message and choose **Open**, **Preview**, or **Download** where available.

Exact supported types, maximum size, and mobile storage behavior depend on deployment/client and require confirmation. Do not attach confidential information unless allowed by your organization.

## 5.8 Start or schedule a meeting/call

1. Open **Meetings** and choose the schedule/new-meeting action.
2. Enter the meeting title and choose audio/video options.
3. Set the date/time and duration if scheduling for later.
4. Add people and/or channels as invitees where available.
5. Review the meeting details and submit.
6. At meeting time, open its detail and choose the join action. Grant microphone/camera access only as needed.

The form may report an invalid time, too many invitees, or unavailable channel members. Use the organizer's invitation link if you are not on the meeting roster.

## 5.9 Use meeting controls

During a call, use **Mute**, **Camera**, **Share**, **People**, **Chats**, and **Notes** where available. Use **End call** to leave/end the meeting; **End for everyone** has a broader effect and should only be used when authorized and intended. Recording may be disabled by browser or deployment configuration.

## 5.10 Invite a teammate

1. On web, open **Invite teammates** (`/app/invite`).
2. Enter the teammate's **Email** and choose **Role** if the selector is available.
3. Select **Send**.
4. Review **Pending invites** and copy/revoke an invitation as needed.

The UI identifies invitations as admin-only. If you do not see this screen or action, ask an organization admin. Desktop may redirect the invite route to Mail.

## 5.11 Manage a member

1. Open **Members** and search for the teammate.
2. Open the member detail and choose the relevant tab.
3. In **Admin**, select an available role/access action such as **Make admin**, **Demote to member**, **Suspend**, **Remove**, or **Reactivate**.
4. Read and confirm the dialog before proceeding.

These actions may sign the member out or revoke workspace access. Self-management and last-admin changes are restricted in the source. Ask another administrator if a control is unavailable.

## 5.12 Export tasks or activity

1. Open the task list or member/workspace activity view.
2. Select **Export**.
3. Choose a supported scope/date range if the dialog offers it.
4. Select **Export** or **Export .xlsx**.
5. Save the generated workbook.

See [Reports and exports](./06-reports-and-exports.md) for confirmed scopes and workbook content. If the period contains no activity, the app may return an empty-result notice instead of a file.

## 5.13 Switch workspace or leave one

Use the organization switcher to change the active workspace. To leave, open **Org**, select the relevant organization, and choose **Leave** if shown. Confirm carefully: leaving removes your access. The UI prevents leaving the only workspace and the last-admin workspace; ask an admin to transfer ownership or membership first.

## 5.14 Update profile and secure the account

1. Open your profile menu and choose **Edit profile**.
2. Update **Display name** and/or **Change photo**, then select **Save changes**.
3. Open **Settings > Security** to enroll in MFA or change the password.
4. Open **Settings > Active sessions** to sign out a lost/old device.

MFA disable/backup-code regeneration can require step-up verification. Keep backup codes private and store them securely.

## 5.15 Pin or unpin a task sticky

Use **Pin task** on a task where that control appears. On web, a pinned task may display as a movable browser overlay; on desktop, the app may display a native sticky. Choose **Unpin** to remove the overlay without assuming that the task itself is deleted. Availability and desktop note limits need release verification.

## 5.16 Delete or remove content

The UI provides actions to discard a draft, remove/delete a mail copy, leave/remove a member, and leave a channel. These actions do not all have the same effect. Read each confirmation. A general delete-task action was not established in the main task UI and is not documented as available.

## 5.17 Request or cancel workspace deletion

**Organization-admin only; destructive.** Deletion signs everyone out and permanently destroys workspace messages, files, tasks, and activity after a grace period.

1. Open **Org**.
2. In the **Danger zone**, select **Delete this workspace…**.
3. Read the warning and type the exact workspace identifier shown.
4. Select **Delete workspace** only if the organization owner has approved deletion.
5. To reverse a pending request before its displayed deadline, return to **Org** and select **Cancel deletion**.

The grace-period length is deployment/service-controlled and not specified in this manual. If the workspace is already scheduled for deletion and the cancel action is missing, contact an administrator immediately.
