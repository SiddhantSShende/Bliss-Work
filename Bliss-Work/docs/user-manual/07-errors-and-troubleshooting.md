# 7. Errors and Troubleshooting

Messages below are from application English strings or error states found in source. A cause marked **possible** has not been confirmed from a live incident.

| Error or symptom | Location | Cause | Resolution steps | Escalation |
|---|---|---|---|---|
| `Invalid email or password` | Sign in | Possible: incorrect email/password or wrong workspace login page. | Check the email and workspace URL; use **Forgot password?** if needed. | Workspace administrator if the account may be disabled. |
| `Security check required` / `Incorrect security check` | Sign in/onboarding | Challenge is required or answer did not match; case matters. | Refresh the challenge and enter it exactly as shown. | Administrator if it repeats on a supported client. |
| `Too many attempts` | Sign in, MFA, password change | Request throttling or repeated incorrect attempts. | Wait for the UI's stated interval, then retry once. | Administrator if the account remains blocked. |
| `Can't reach the server` | Sign in | Possible: network, VPN, DNS, or authentication service unavailable. | Check the workspace URL and network; retry after service availability is confirmed. | Workspace administrator/support. |
| `This link is invalid or has expired.` | Password reset/email verification | Link is missing, expired, already used, or malformed. | Request a fresh reset/verification message. | Administrator if a new link also fails. |
| `Invite expired` / `Invalid invite` | Invitation acceptance | Invitation is expired, revoked, or token is missing. | Ask the inviter/admin to send a new invitation. | Organization admin. |
| `Couldn't load notifications` | Notification panel | Possible: temporary connection or notification-service error. | Select **Try again**; check connection. | Administrator if notifications remain unavailable. |
| `This mail could not be opened. It may have been removed.` | Mail detail | Mail is no longer available to this mailbox or failed to load. | Return to the list and refresh; check Deleted or ask the sender to resend. | Administrator if repeated for multiple messages. |
| `This does not look like an email address` | Mail composer | Recipient address is invalid. | Correct or remove the recipient chip. | Not usually required. |
| `Subject is … characters — the limit is …` | Mail composer | Subject exceeds the displayed limit. | Shorten the subject and retry. | Administrator if the displayed limit is unclear. |
| `Could not attach …` / `… is larger than …` | Mail/chat attachment | Upload failed or file exceeds a configured limit. | Check file size/type and connection; retry with an allowed file. | Administrator if an allowed file repeatedly fails. |
| `Couldn't create the project` / `Give the project a name` | Project creation | Required name/channel missing or a service failure. | Enter a project name, select an eligible channel, then retry. | Administrator if channel eligibility or service error persists. |
| `Choose a future date and time` / `The deadline must be in the future` | Task scheduling | Schedule/deadline is invalid or in the past. | Select a future date/time and review schedule/deadline order. | Administrator if timezone behavior appears incorrect. |
| `Couldn't acknowledge/complete/leave the task` | Task action | Possible: task changed state, deadline passed, permission changed, or service/network failure. | Refresh the task and check its current state; retry only if the action remains available. | Allocator/admin if state or assignment is unexpected. |
| `Project lookup failed. Retry, or continue creating the task.` | Task create form | Project list lookup failed. | Retry lookup; verify the project or create without it if appropriate. | Workspace admin if repeated. |
| `The task was saved, but project channel membership could not be updated.` | Project/task flow | Task creation succeeded but a follow-up channel update failed. | Check the task, then ask an admin to review project channel membership. | Organization admin. |
| `This meeting isn't available` / `This meeting has ended` | Meeting detail/join | Link invalid, meeting ended, user no longer on roster, or meeting unavailable. | Return to Meetings; ask the organizer for a valid invitation if needed. | Meeting organizer/admin. |
| `Camera/microphone blocked` / `Camera unavailable` | Call | Device permission denied or camera/microphone unavailable. | Allow the required permission in the OS/browser and rejoin. | Device administrator if policy blocks access. |
| `Couldn't load billing information.` / `Billing unavailable` | Billing | Service error or billing not configured in this deployment. | Retry; if unavailable persists, ask an organization admin. | Billing/workspace administrator. |
| Activity export reports no rows | Activity export | Selected date range has no recorded activity. | Widen the date range and check collection/settings. | Administrator if expected data is missing. |
| A menu or admin button is missing | Any role-gated view | Possible: current role, workspace configuration, or client difference. | Confirm active organization and ask an admin to check access. | Organization admin. |
| App looks different from this guide | Any screen | Version, localization, platform, or deployment differs. | Check the app version and use the relevant client instructions. | Product/support contact **[To be confirmed]**. |

## 7.1 General recovery

1. Record the exact message, page, time, client (web/desktop/mobile), and workspace.
2. Do not include passwords, one-time codes, backup codes, cookies, or private message content in a support request.
3. Refresh once if the screen offers **Retry**. Avoid repeated submissions for actions that may create or send content.
4. If the issue affects access or multiple users, contact the workspace administrator through your approved support channel.

