# 6. Reports and Exports

## 6.1 Task export

The Tasks view contains an **Export** action and a dialog titled **Export tasks to Excel**. Select a **Which tasks** scope:

- **All my tasks**
- **Allocated by me**
- **Assigned to me**

Then choose **Past week**, **Past month**, **Past year**, **All time**, or **Custom range**. A custom range requires both **From** and **To** dates. The UI says exported times use your device's local timezone and creates one row per person the task was allocated to.

The service maps these choices to `sent`, `received`, or `all`, accepts ISO-8601 bounds, caps returned records at 5,000, and is rate-limited. Invalid scope/date values produce validation errors. Exact workbook columns and role restrictions still require confirmation.

**If the export is empty or fails:** verify the scope/date range, confirm tasks exist in that period, retry after checking connectivity, and contact an administrator if the same failure continues.

## 6.2 Activity export

The member/workspace activity interface has **Export** / **Export .xlsx** actions and a date-range form with **From**, **To**, and **Custom range**. The UI describes one row per member/day with active and idle time, sessions, recorded actions, and the most-used section, using the user's timezone.

Source locale strings name three workbook sheets:

1. **Summary**
2. **Daily**
3. **Sessions**

Available columns include member/email, day, active/idle, sessions, actions, first/last seen, top section, device, start/end, end reason, and network. Actual columns can vary by report and selected scope.

Members can view their own activity record. Organization-wide reports and other members' records are documented as admin-only in the repository's telemetry documentation. The exact export-dialog entry point for each role should be verified in the running app.

**Empty report:** the UI message is `No activity in that period — nothing to export.` Choose a wider date range or confirm that activity is being collected.

## 6.3 Analytics screens

Analytics views include workspace overview, project and channel analytics, and member activity summaries. They may show active time, sessions, event counts, application usage, recent activity, work-time patterns, and task/project summaries. They are interactive views, not a confirmed downloadable report in every case.

Chart definitions, default period, data retention window, and the full access matrix are **[To be confirmed]**. Use the screen's own filters where available and note that no activity can result in an empty chart.

## 6.4 Downloading an export safely

1. Choose the correct organization and report scope.
2. Limit the date range to the information needed.
3. Start the export and save the `.xlsx` file to an approved location.
4. Treat exported member and activity information as confidential workspace data.
5. If no file is created, check the download shelf/folder and the app's error message before retrying.

## 6.5 Export status and permissions

The source defines success, no-data, and failure feedback for activity export. Task exports can fail validation or due to rate limits. Access depends on the report and role; report controls being visible in source does not prove access in every deployment. Ask your workspace administrator if the export action is missing or access is denied.
