# 3. Dashboard and Navigation

## 3.1 Web and desktop layout

The authenticated application shell contains a top bar, section navigation, a contextual list pane for sections that have lists, and the main content pane. On narrower screens, the list and detail panes take turns using the available width. The navigation and most application sections are shared between web and desktop clients.

The app's default `/app` route sends the user to **Analytics**. The web/desktop navigation labels in the English UI are:

| Label | Opens |
|---|---|
| Analytics | Workspace overview and activity/task analytics views |
| Mail | Mail folders and messages |
| Meetings | Meeting calendar and meeting details |
| Chats | Direct conversations |
| Tasks | Task categories and projects |
| Channels | Channel list and conversations |
| Members | Workspace member directory and activity |
| Org | Organization/workspace information and membership |
| Settings | Profile preferences, activity, security, sessions, and billing entry points |

## 3.2 Top bar and account controls

Source code shows top-bar controls for the organization switcher, search, notifications, and profile/account menu. The web interface also has an invite shortcut; desktop routes the invite shortcut to Mail instead of showing the web invitation page.

The account menu includes **Edit profile**, **Settings**, **Light mode**, **Dark mode**, and **Sign out**. The organization switcher changes the active workspace. Exact icon placement and responsive visibility should be checked in a running deployment.

## 3.3 Notifications and status indicators

- Unread badges can appear on Mail, Tasks, Chats, and Channels navigation items.
- The notification panel has unread/read feeds, **Mark read**, **Load more**, and a retry state.
- Notification rows can navigate to the related feature. Some activity is also surfaced as in-app banners or meeting notices.
- Mobile tab badges show unread chat, task, mail, or channel counts, with the mobile tab count capped at `99+`.

The panel's contents depend on activity and workspace configuration. No live notification was verified.

## 3.4 Search

Use the search control in the top bar. Search results are grouped as **People**, **Channels**, **Chats**, and **Tasks**. The search screen has empty and no-match states. Search across mail or meetings was not established by the inspected UI.

## 3.5 Mobile navigation

The mobile app has five bottom tabs: **Home**, **Chats**, **Tasks**, **Meetings**, and **More**. The **More** area provides additional entry points, including Mail, Channels, Members, Org, account/profile, settings, and activity. Exact menu contents vary by role and have not been verified on a device.

## 3.6 Theme and language

Light and dark appearance controls are present. Theme preference behavior is supported in client code; actual appearance may follow a saved user preference.

English is the production-ready UI language according to the localization documentation. Other locale catalogs exist but are gated from production pending review; the mobile UI currently has no localization integration. A language selector may appear in development or future builds but should not be expected in every production deployment.
