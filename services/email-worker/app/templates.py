"""HTML + plain-text invite email rendering (Jinja2)."""
from __future__ import annotations

from jinja2 import Environment, select_autoescape

_env = Environment(autoescape=select_autoescape(["html"]))

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

_TEXT_TEMPLATE = _env.from_string(
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

_NEW_MSG_TEXT = _env.from_string(
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
    <title>{{ sender_username }} assigned you a task on BlissWork</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 0;">
      <tr><td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0"
               style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
          <tr><td style="padding:32px 40px 8px 40px;">
            <h1 style="margin:0 0 8px 0;font-size:22px;line-height:1.3;">
              {{ sender_username }} assigned you a task
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
              You're getting this because you weren't online when the task was assigned.
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>
"""
)

_NEW_TASK_TEXT = _env.from_string(
    """\
{{ sender_username }} assigned you a task on BlissWork.

Title: {{ title }}
{% if description %}
{{ description }}
{% endif %}
Open in BlissWork: {{ link }}

You're getting this because you weren't online when the task was assigned.
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
) -> tuple[str, str]:
    """Render the offline-relay 'you got a new task' email."""
    ctx = {
        "sender_username": sender_username,
        "title": title,
        "description": description,
        "link": link,
    }
    return _NEW_TASK_TEXT.render(**ctx), _NEW_TASK_HTML.render(**ctx)
