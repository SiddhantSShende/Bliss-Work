# Screenshot Checklist

**Capture status:** No screenshots were captured. `http://localhost:5173` refused the connection, and no approved test deployment or authenticated session was available. Existing image assets were inspected: the repository contains the BlissWork logo and application/platform icons, but these are not application screenshots.

Use synthetic data and an approved test environment. Do not show passwords, MFA/backup codes, customer names, private messages, real email addresses, tokens, or session information. Mask account identifiers and use sample users such as `Example Member`.

| Suggested filename | Manual section | Screen/description | Capture status |
|---|---|---|---|
| `01-login.png` | 2, 4.1 | Web sign-in, empty fields and primary controls | Pending — capture in approved test environment |
| `02-login-validation.png` | 7 | Safe validation/error state (synthetic account; no credential shown) | Pending |
| `03-onboarding.png` | 2, 4.1 | New workspace form | Pending |
| `04-invite-accept.png` | 2, 4.1 | Valid synthetic invitation acceptance | Pending |
| `05-dashboard-analytics.png` | 3, 4.2 | Analytics overview with synthetic data | Pending |
| `06-navigation-notifications.png` | 3, 4 | Top bar, section navigation, unread badge and notification panel | Pending |
| `07-search-results.png` | 3, 4.2 | Search results with synthetic people/channels/tasks | Pending |
| `08-mail-list.png` | 4.3 | Mail folders and message list | Pending |
| `09-mail-compose.png` | 4.3, 5.6 | New Mail fields, Cc/Bcc and attachment tray | Pending |
| `10-mail-validation.png` | 4.3, 7 | Invalid recipient or safe attachment error state | Pending |
| `11-chat-conversation.png` | 4.4 | Conversation, composer and message actions | Pending |
| `12-channel-details.png` | 4.5 | Channel conversation, members and available actions | Pending |
| `13-task-list-filters.png` | 4.6 | Task categories, filter and list | Pending |
| `14-task-create.png` | 4.6, 5.1 | Task creation fields, assignees and deadline | Pending |
| `15-task-validation.png` | 4.6, 7 | Missing title/recipient or invalid schedule validation | Pending |
| `16-task-status.png` | 4.6, 5.2 | Acknowledge/Complete state and resulting status | Pending |
| `17-project-create.png` | 4.7, 5.5 | Project name and channel selection | Pending |
| `18-meeting-calendar.png` | 4.8 | Meeting calendar/list and filters | Pending |
| `19-meeting-schedule.png` | 4.8, 5.8 | Meeting form with synthetic invitees | Pending |
| `20-active-call.png` | 4.8, 5.9 | Active call controls, synthetic participants | Pending |
| `21-members-list.png` | 4.9 | Member directory and search | Pending |
| `22-member-admin-dialog.png` | 4.9, 5.11 | Role/access confirmation with synthetic member | Pending |
| `23-activity-report.png` | 4.10, 6 | Activity filters, charts and export button | Pending |
| `24-export-result.png` | 6 | Synthetic `.xlsx` export completion/download | Pending |
| `25-profile-settings.png` | 4.11 | Profile fields, theme and security entry points | Pending |
| `26-mfa-setup.png` | 4.11 | MFA enrollment (use a disposable test account; obscure QR/code) | Pending |
| `27-active-sessions.png` | 4.11 | Session list using synthetic device labels | Pending |
| `28-billing.png` | 4.12 | Billing available/unavailable state, without real payment data | Pending |
| `29-browser-sticky.png` | 4.13 | Web task sticky, move/collapse/unpin controls | Pending |
| `30-desktop-sticky.png` | 4.13 | Desktop sticky on a test OS | Pending |
| `31-mobile-home-tabs.png` | 4.15 | Mobile Home and five-tab navigation | Pending |
| `32-mobile-task-detail.png` | 4.15 | Mobile task detail and actions | Pending |
| `33-mobile-meeting.png` | 4.15 | Mobile meeting detail/call controls | Pending |
| `34-org-mfa-policy.png` | 4.9 | Organization-admin MFA policy, using a synthetic test organization | Pending — admin/test environment required |
| `35-org-deletion-confirm.png` | 4.9, 5.17 | Deletion confirmation with a synthetic organization identifier; do not submit in a real workspace | Pending — explicit test-owner approval required |
| `36-org-deletion-pending.png` | 4.9, 5.17 | Scheduled-deletion state and **Cancel deletion** action in a disposable test organization | Pending — explicit test-owner approval required |

Before publication, confirm every image was actually captured, add it to the approved documentation asset location, and update its status and relative image link. Do not mark a row complete solely because a similar icon or splash image exists.
