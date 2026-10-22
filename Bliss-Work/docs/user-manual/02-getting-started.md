# 2. Getting Started

## 2.1 Open BlissWork

Use the workspace URL provided by your organization. The repository's `http://localhost:5173` address is for local development only; it is not a general sign-in link.

BlissWork has web, desktop, and mobile clients. Desktop installation packages are present for Windows, macOS, and Linux; use the download/installation instructions approved by your administrator. Mobile minimum OS versions and distribution links are **[To be confirmed]**.

## 2.2 Sign in

1. Open the organization's BlissWork sign-in page.
2. Enter your **Email** and **Password**.
3. Complete the **Security check** if the sign-in page requests it. CAPTCHA answers are case-sensitive; use **Refresh security check** if the challenge is unclear.
4. Select **Sign in**.
5. If your account requires two-factor authentication, enter the code from your authenticator app, or choose the backup-code option.

The web login UI reports `Invalid email or password`, a security-check error, rate limiting, a server response, or a connectivity problem as separate cases. Do not repeatedly retry after a rate-limit message; wait before trying again.

## 2.3 Create a workspace

The web application has a **Need a workspace? / Create one** path. The onboarding form shows:

- **Organization name**
- **Your name**
- **Email**
- **Password**
- A security check when requested

The visible password rule is at least 10 characters and must include a letter, a number, and a special character. Select **Create organization** to submit. A successful creation outcome depends on deployment policy and is not runtime verified. The mobile login screen directs workspace creation to the web application; a mobile creation form was not found.

## 2.4 Join by invitation

1. Open the invitation link sent by your organization.
2. Check that the displayed workspace and invited email address are correct.
3. Enter the required **Username**, **Display name**, and **Password**.
4. Select **Join workspace**.

An absent, expired, or invalid invitation cannot be accepted; ask the inviter or an administrator for a current invitation. The invitation acceptance screen's exact live behavior has not been inspected.

## 2.5 Forgot or reset a password

1. On the sign-in page, select **Forgot password?**.
2. Enter your email and select **Send reset link**.
3. Check your email for the reset message. The UI says the link expires after 30 minutes; check spam/junk if it is not received.
4. Open the link, enter a new password, and select **Update password**.
5. Return to sign-in and use the new password.

The reset confirmation is intentionally phrased so it does not disclose whether an email address has an account. Request another link if the existing link is invalid or expired.

## 2.6 Email verification

If BlissWork shows an email-verification banner, use **Resend** and then open the confirmation link from your email. The banner can be dismissed for the current session. If the link is expired, return to the app and request a new one.

## 2.7 Profile and first-time setup

After signing in, open your profile menu and choose **Edit profile** to review your display name and profile photo. Some identity values, such as email and username, are read-only in the profile UI. See [Account and settings](./04-module-documentation.md).

If your organization requires MFA for administrators, a banner may direct you to **Settings > Security**. Complete setup before the workspace's enforcement deadline.

## 2.8 Sign out and session expiry

Use **Sign out** in the account menu when finished on a shared device. Use **Settings > Active sessions** to end a session on a device you no longer use or recognize.

The exact idle timeout and session-expiry duration are **[To be confirmed]**. If a session expires, sign in again. If MFA is required, complete the second-factor step.

## 2.9 Sign-in troubleshooting

| Message/symptom | What to try |
|---|---|
| `Invalid email or password` | Check the email spelling and password; use **Forgot password?** if needed. |
| `Security check required` / `Incorrect security check` | Complete or refresh the challenge; remember that upper/lower case differs. |
| `Too many attempts` | Wait for the stated interval before retrying. |
| `Can't reach the server` | Check the workspace URL and network/VPN, then ask the administrator whether the service is available. |
| MFA code rejected | Check the authenticator's current code or use an unused backup code. |
| Invitation is invalid or expired | Request a fresh invitation from the inviter or workspace admin. |
| Reset link expired | Request a new reset link from the sign-in page. |

See [Errors and troubleshooting](./07-errors-and-troubleshooting.md) for more help.
