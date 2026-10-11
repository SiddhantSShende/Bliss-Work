"""HTML + plain-text invite email rendering (Jinja2)."""
from __future__ import annotations

from jinja2 import Environment, select_autoescape

_env = Environment(autoescape=select_autoescape(["html"]))

# select_autoescape(["html"]) decides by FILE EXTENSION — meaningless for a
# template compiled with from_string(), which has no filename (name=None).
# Jinja's default_for_string then applies, which defaults to True: every
# from_string() template on `_env`, HTML or not, silently autoescaped. That
# was fine for the HTML halves (interpolating a name/message into markup
# genuinely needs escaping) but wrong for the PLAIN-TEXT halves below,
# which got HTML-entity-escaped too — a name like "O'Brien" or a subject
# containing "R&D" was corrupted in the text/plain MIME part of every email
# this service sends, including a user's own composed mail body (see
# render_user_mail). A separate, explicitly non-autoescaping environment for
# every _*_TEXT template fixes this without touching the HTML ones.
_text_env = Environment(autoescape=False)  # noqa: S701 — plain text, never rendered as markup

_HTML_TEMPLATE = _env.from_string(
    """\
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>You're invited to {{ org_name }} on BlissWork</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0"
                 style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
            <tr>
              <td style="padding:32px 40px 8px 40px;">
                <h1 style="margin:0 0 16px 0;font-size:22px;line-height:1.3;">
                  You're invited to {{ org_name }}
                </h1>
                <p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;color:#444;">
                  {{ invited_by }} has invited you to join
                  <strong>{{ org_name }}</strong> on BlissWork.
                </p>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:8px 40px 24px 40px;">
                <a href="{{ invite_url }}"
                   style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;
                          font-size:16px;font-weight:bold;padding:14px 32px;border-radius:8px;">
                  Accept invitation
                </a>
              </td>
            </tr>
            <tr>
              <td style="padding:0 40px 32px 40px;">
                <p style="margin:0 0 8px 0;font-size:13px;line-height:1.6;color:#666;">
                  Or paste this link into your browser:
                </p>
                <p style="margin:0 0 20px 0;font-size:13px;line-height:1.6;word-break:break-all;">
                  <a href="{{ invite_url }}" style="color:#4f46e5;">{{ invite_url }}</a>
                </p>
                <p style="margin:0;font-size:13px;line-height:1.6;color:#999;">
                  This invitation expires on <strong>{{ expires_at }}</strong>.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
"""
)

_TEXT_TEMPLATE = _text_env.from_string(
    """\
You're invited to {{ org_name }} on BlissWork

{{ invited_by }} has invited you to join {{ org_name }} on BlissWork.

Accept your invitation:
{{ invite_url }}

This invitation expires on {{ expires_at }}.
"""
)


def render_invite_email(
    *,
    org_name: str,
    invited_by: str,
    invite_url: str,
    expires_at: str,
) -> tuple[str, str]:
    """Return (text_body, html_body)."""
    ctx = {
        "org_name": org_name,
        "invited_by": invited_by,
        "invite_url": invite_url,
        "expires_at": expires_at,
    }
    return _TEXT_TEMPLATE.render(**ctx), _HTML_TEMPLATE.render(**ctx)


# ─────────────────────────────────────────────────────────────────────────────
# Phase 6: offline-relay templates for new messages and new tasks.
# Reuses the visual language of the invite email (centered card, brand button)
# so the recipient sees a consistent BlissWork-shaped notification regardless
# of which event triggered it.
# ─────────────────────────────────────────────────────────────────────────────

_NEW_MSG_HTML = _env.from_string(
    """\
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>New message from {{ sender_username }} on BlissWork</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 0;">
      <tr><td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0"
               style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
          <tr><td style="padding:32px 40px 8px 40px;">
            <h1 style="margin:0 0 16px 0;font-size:22px;line-height:1.3;">
              {{ sender_username }} sent you a message
            </h1>
            <blockquote style="margin:0 0 16px 0;padding:12px 16px;border-left:3px solid #4f46e5;
                               background:#f7f7fb;font-size:15px;line-height:1.55;color:#333;">
              {{ body_preview }}
            </blockquote>
          </td></tr>
          <tr><td align="center" style="padding:8px 40px 24px 40px;">
            <a href="{{ link }}"
               style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;
                      font-size:16px;font-weight:bold;padding:14px 32px;border-radius:8px;">
              Reply in BlissWork
            </a>
          </td></tr>
          <tr><td style="padding:0 40px 32px 40px;">
            <p style="margin:0;font-size:13px;line-height:1.6;color:#999;">
              You're getting this because you weren't online when the message arrived.
              You can change notification settings in BlissWork → Profile.
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>
"""
)

_NEW_MSG_TEXT = _text_env.from_string(
    """\
{{ sender_username }} sent you a message on BlissWork.

> {{ body_preview }}

Reply: {{ link }}

You're getting this because you weren't online when the message arrived.
"""
)

_NEW_TASK_HTML = _env.from_string(
    """\
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>{{ heading }} on BlissWork</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 0;">
      <tr><td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0"
               style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
          <tr><td style="padding:32px 40px 8px 40px;">
            <h1 style="margin:0 0 8px 0;font-size:22px;line-height:1.3;">
              {{ heading }}
            </h1>
            <h2 style="margin:0 0 12px 0;font-size:17px;line-height:1.4;color:#333;">
              {{ title }}
            </h2>
            {% if description %}
            <p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;color:#444;">
              {{ description }}
            </p>
            {% endif %}
          </td></tr>
          <tr><td align="center" style="padding:8px 40px 24px 40px;">
            <a href="{{ link }}"
               style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;
                      font-size:16px;font-weight:bold;padding:14px 32px;border-radius:8px;">
              Open in BlissWork
            </a>
          </td></tr>
          <tr><td style="padding:0 40px 32px 40px;">
            <p style="margin:0;font-size:13px;line-height:1.6;color:#999;">
              {{ footer_note }}
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>
"""
)

_NEW_TASK_TEXT = _text_env.from_string(
    """\
{{ heading }} on BlissWork.

Title: {{ title }}
{% if description %}
{{ description }}
{% endif %}
Open in BlissWork: {{ link }}

{{ footer_note }}
"""
)


def render_new_message_email(
    *,
    sender_username: str,
    body_preview: str,
    link: str,
) -> tuple[str, str]:
    """Render the offline-relay 'you got a new message' email.

    body_preview is truncated to ~200 chars by the caller; do not allow raw
    HTML inside the blockquote (jinja autoescape handles this).
    """
    ctx = {
        "sender_username": sender_username,
        "body_preview": body_preview,
        "link": link,
    }
    return _NEW_MSG_TEXT.render(**ctx), _NEW_MSG_HTML.render(**ctx)


def render_new_task_email(
    *,
    sender_username: str,
    title: str,
    description: str,
    link: str,
    channel_name: str | None = None,
) -> tuple[str, str]:
    """Render the offline-relay 'you got a new task' email.

    When `channel_name` is set, this assignee was reached via that channel's
    membership rather than named directly — the heading and footer note call
    that out instead of implying a personal/direct assignment.
    """
    if channel_name:
        heading = f"{sender_username} assigned a task to #{channel_name}"
        footer_note = (
            f"You're getting this because you're a member of #{channel_name} and "
            "weren't online when the task was assigned."
        )
    else:
        heading = f"{sender_username} assigned you a task"
        footer_note = "You're getting this because you weren't online when the task was assigned."
    ctx = {
        "heading": heading,
        "title": title,
        "description": description,
        "link": link,
        "footer_note": footer_note,
    }
    return _NEW_TASK_TEXT.render(**ctx), _NEW_TASK_HTML.render(**ctx)


# ─────────────────────────────────────────────────────────────────────────────
# User-composed mail. Unlike everything else in this module, the content is not
# ours: it is a person's own email, being relayed to an address outside the
# workspace. So there is no card, no brand button and no call to action — the
# body is the message, and dressing it in a notification template would turn
# somebody's email into an advert for the product they sent it from.
#
# The ONLY addition is a one-line footer naming the workspace it came through,
# which the recipient needs in order to make sense of a From address that is
# not the author's own (see Mailer.send for why it cannot be).
# ─────────────────────────────────────────────────────────────────────────────

_USER_MAIL_HTML = _env.from_string(
    """<!doctype html>
<html><body style="margin:0;padding:24px;background:#ffffff;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
  font-size:15px;line-height:1.6;color:#111827;">
  <div style="white-space:pre-wrap;">{{ body }}</div>
  <hr style="margin:28px 0 12px;border:0;border-top:1px solid #e5e7eb;">
  {%- if skipped_files %}
  <p style="margin:0 0 8px;font-size:12px;color:#6b7280;">
    {{ skipped_files | length }} file{{ '' if skipped_files | length == 1 else 's' }}
    could not be attached to this email:
    {% for name in skipped_files %}{{ name }}{{ ", " if not loop.last }}{% endfor %}.
    Ask {{ sender_name }} to share {{ 'it' if skipped_files | length == 1 else 'them' }} another way.
  </p>
  {%- endif %}
  <p style="margin:0;font-size:12px;color:#6b7280;">
    Sent by {{ sender_name }}{% if sender_address %} ({{ sender_address }}){% endif %}
    via BlissWork. Reply to this email to reach them directly.
  </p>
</body></html>"""
)

_USER_MAIL_TEXT = _text_env.from_string(
    """{{ body }}

--
{% if skipped_files %}{{ skipped_files | length }} file{{ '' if skipped_files | length == 1 else 's' }} could not be attached to this email: {% for name in skipped_files %}{{ name }}{{ ", " if not loop.last }}{% endfor %}.
Ask {{ sender_name }} to share {{ 'it' if skipped_files | length == 1 else 'them' }} another way.

{% endif %}Sent by {{ sender_name }}{% if sender_address %} ({{ sender_address }}){% endif %} via BlissWork.
Reply to this email to reach them directly."""
)


def render_user_mail(
    *,
    body: str,
    sender_name: str,
    sender_address: str,
    skipped_files: list[str] | None = None,
) -> tuple[str, str]:
    """Render a user's own email for relay to an external address.

    ``body`` is the author's plain text and is NOT interpreted as markup —
    jinja autoescape covers the HTML part, and the text part is passed through
    verbatim.

    ``skipped_files`` names attachments this copy does NOT carry, because they
    exceeded what email can hold or could not be read. They are named rather
    than dropped in silence: a recipient who knows a file exists can ask for it,
    while a recipient who was told nothing reads a message referring to an
    attachment that isn't there.
    """
    ctx = {
        "body": body,
        "sender_name": sender_name or "a BlissWork user",
        "sender_address": sender_address,
        "skipped_files": skipped_files or [],
    }
    return _USER_MAIL_TEXT.render(**ctx), _USER_MAIL_HTML.render(**ctx)


# ─────────────────────────────────────────────────────────────────────────────
# Account-security emails: password reset + email verification. Same visual
# language as the invite email (centered card, brand button). The security
# copy ("didn't request this?" / expiry) is deliberate.
# ─────────────────────────────────────────────────────────────────────────────


def _action_email(
    *, title: str, lead: str, button: str, url: str, note: str
) -> tuple[str, str]:
    """Shared centered-card action email used by the reset + verify flows."""
    html = _env.from_string(
        """\
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>{{ title }}</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 0;">
      <tr><td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0"
               style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
          <tr><td style="padding:32px 40px 8px 40px;">
            <h1 style="margin:0 0 16px 0;font-size:22px;line-height:1.3;">{{ title }}</h1>
            <p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;color:#444;">{{ lead }}</p>
          </td></tr>
          <tr><td align="center" style="padding:8px 40px 24px 40px;">
            <a href="{{ url }}"
               style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;
                      font-size:16px;font-weight:bold;padding:14px 32px;border-radius:8px;">
              {{ button }}
            </a>
          </td></tr>
          <tr><td style="padding:0 40px 32px 40px;">
            <p style="margin:0 0 8px 0;font-size:13px;line-height:1.6;color:#666;">
              Or paste this link into your browser:
            </p>
            <p style="margin:0 0 20px 0;font-size:13px;line-height:1.6;word-break:break-all;">
              <a href="{{ url }}" style="color:#4f46e5;">{{ url }}</a>
            </p>
            <p style="margin:0;font-size:13px;line-height:1.6;color:#999;">{{ note }}</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>
"""
    )
    text = _text_env.from_string(
        """\
{{ title }}

{{ lead }}

{{ button }}:
{{ url }}

{{ note }}
"""
    )
    ctx = {"title": title, "lead": lead, "button": button, "url": url, "note": note}
    return text.render(**ctx), html.render(**ctx)


def render_password_reset_email(*, reset_url: str, expires_at: str) -> tuple[str, str]:
    """Return (text_body, html_body) for the password-reset email."""
    note = (
        f"This link expires on {expires_at}. If you didn't request a password "
        "reset, you can safely ignore this email — your password won't change."
    )
    return _action_email(
        title="Reset your BlissWork password",
        lead="We received a request to reset your BlissWork password. Click the button below to choose a new one.",
        button="Reset password",
        url=reset_url,
        note=note,
    )


def render_email_verification_email(*, verify_url: str, expires_at: str) -> tuple[str, str]:
    """Return (text_body, html_body) for the email-verification email."""
    note = (
        f"This link expires on {expires_at}. If you didn't create a BlissWork "
        "account, you can safely ignore this email."
    )
    return _action_email(
        title="Verify your BlissWork email",
        lead="Confirm this is your email address to finish securing your BlissWork account.",
        button="Verify email",
        url=verify_url,
        note=note,
    )
