# Open Questions

These items need product-owner, administrator, or live-environment confirmation before this manual can be treated as final.

## Product and document metadata

- What is the official company/legal attribution? The UI source says “AEIV Global Private Limited,” but legal attribution should be confirmed.
- What product version/build should appear on the cover? Repository package versions differ by client, and release versioning is not established as a single product version.
- Who is the manual's author/responsible team and approval owner?
- What is the official support email, help URL, and incident/escalation channel?
- The mobile **Help & Support > Contact** button opens a mail link, but the configured address appears to identify an individual rather than a shared support inbox. Confirm the approved public contact before publishing it.
- What workspace login URL should users use in each deployment?

## Requirements and access

- Which browser names and minimum versions are supported?
- What are the minimum Android/iOS versions and supported device requirements?
- What network, firewall, proxy, VPN, WebSocket, and media connectivity requirements should users follow?
- What is the supported session/idle timeout?
- Where should users obtain signed/approved desktop installers and mobile store builds?

## Features, roles, and configuration

- Confirm the complete role/permission matrix for invites, member administration, channel moderation, task reassign/review, analytics, exports, meetings, billing, and organization lifecycle actions.
- Confirm which deployments expose integrations, provider linking, OAuth credentials, billing purchases, call recording, office previews, and activity collection.
- The backend has integration/OAuth APIs, but no ordinary end-user integration settings route was found. Is this feature hidden, planned, or not supported for users?
- Repository telemetry documentation refers to an `apps/extension` browser activity extension, but that directory/distribution was not found in the inspected application tree. Is the extension current, distributed separately, or obsolete?
- Confirm exact task export dialog scopes, date range controls, workbook columns, timezone behavior, and role restrictions.
- Confirm analytics metric definitions, default periods, and retention windows.
- Confirm file type and size limits across web, desktop, and mobile, including download/open behavior.
- Confirm whether task deletion is intentionally unavailable and document any admin-only deletion path if one exists.
- Confirm the organization deletion grace-period length, who is permitted to request/cancel it, and the policy for communicating this irreversible action to all members.
- Confirm whether desktop task-stickies still have a five-item cap and what their current platform behavior is.
- Confirm if browser themes/language controls are exposed in the released production app; current localization documentation says non-English catalogs are gated.
- Confirm feature parity across web, desktop, and mobile, especially administration, projects, reports, and notifications.
- Confirm whether task/channel/meeting controls vary by organization policy beyond the source-level UI conditions.

## Screens and runtime verification

- Local web UI was inaccessible at `http://localhost:5173` (connection refused). Is an approved test environment and synthetic account available for screenshot capture?
- No screen was UI verified. Capture and review the pending screenshots in [SCREENSHOT-CHECKLIST.md](./SCREENSHOT-CHECKLIST.md).
- Confirm the final English text/labels against the running release, including areas that can be localized or changed by feature flags.
- Confirm the behavior of empty/error states, notification click-through, calls/permissions, and export downloads with a live backend.
- Confirm whether desktop and mobile operating-system permission prompts differ from the source-level descriptions.

## Documentation scope and safety

- Reconcile this source-reviewed draft with the existing [`docs/USER_MANUAL.md`](../USER_MANUAL.md), which was not fully reconciled in this task and may contain older or conflicting instructions.
- Review the activity-record description and privacy notice with the responsible privacy/legal owner before publication.
- Confirm what deployment-specific actions may be documented for billing, member removal, workspace deletion, and security settings.
- Ensure screenshots use synthetic data and do not expose credentials, tokens, personal/member data, or private communications.
