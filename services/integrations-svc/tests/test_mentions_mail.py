"""Gmail + Outlook mention extraction.

Mail has no @-mention markup, so "tagged" means "addressed to you" — To or Cc.
The hard part is everything that is technically addressed to you but is not a
person asking for something: newsletters, list mail, auto-replies, and your own
sent mail echoing back through the mailbox.
"""

from app.mentions import detect_mentions

ME = "me@acme.com"
BOSS = "boss@acme.com"


# ── Gmail ─────────────────────────────────────────────────────────────────────
def gmail_msg(headers: dict[str, str], *, msg_id="m1", thread_id="t1"):
    return {
        "id": msg_id,
        "threadId": thread_id,
        "payload": {"headers": [{"name": k, "value": v} for k, v in headers.items()]},
    }


def gscan(headers, connected=ME):
    return detect_mentions("gmail", gmail_msg(headers), connected_account=connected)


def test_address_in_to_is_a_mention():
    assert gscan({"From": BOSS, "To": ME}).handles == (ME,)


def test_address_in_cc_is_a_mention():
    # Being copied on a thread that names you is still being addressed.
    assert gscan({"From": BOSS, "Cc": ME}).handles == (ME,)


def test_display_name_form_is_parsed():
    assert gscan({"From": BOSS, "To": f'"Me Myself" <{ME}>'}).handles == (ME,)


def test_addresses_are_lowercased_for_stable_matching():
    assert gscan({"From": BOSS, "To": "Me@ACME.com"}).handles == (ME,)


def test_all_recipients_are_returned_not_just_the_connected_mailbox():
    # A shared inbox can tag several teammates in one message; the identity
    # table decides which of them exist in this org.
    s = gscan({"From": "ext@x.com", "To": f"{ME}, {BOSS}"})
    assert s.handles == (ME, BOSS)


def test_duplicate_recipient_across_to_and_cc_is_one_handle():
    assert gscan({"From": BOSS, "To": ME, "Cc": ME}).handles == (ME,)


def test_header_names_are_case_insensitive():
    assert gscan({"FROM": BOSS, "TO": ME}).handles == (ME,)


def test_self_echo_of_sent_mail_is_not_a_mention():
    assert gscan({"From": ME, "To": BOSS}).handles == ()


def test_self_echo_check_is_case_insensitive():
    assert gscan({"From": "ME@Acme.com", "To": BOSS}).handles == ()


def test_newsletters_are_not_mentions():
    for header in ("List-Id", "List-Unsubscribe", "List-Post"):
        assert gscan({"From": BOSS, "To": ME, header: "<x>"}).handles == (), header


def test_bulk_precedence_is_not_a_mention():
    for value in ("bulk", "list", "junk", "Bulk"):
        assert gscan({"From": BOSS, "To": ME, "Precedence": value}).handles == (), value


def test_auto_replies_are_not_mentions():
    for value in ("auto-replied", "auto-generated", "auto-notified"):
        assert gscan({"From": BOSS, "To": ME, "Auto-Submitted": value}).handles == (), value


def test_auto_submitted_no_is_a_normal_message():
    # RFC 3834 says "no" means a human sent it.
    assert gscan({"From": BOSS, "To": ME, "Auto-Submitted": "no"}).handles == (ME,)


def test_gmail_thread_ref_and_permalink():
    s = detect_mentions(
        "gmail", gmail_msg({"From": BOSS, "To": ME}, msg_id="abc", thread_id="thr9")
    )
    assert s.thread_ref == "thr9"
    assert s.permalink == "https://mail.google.com/mail/u/0/#all/abc"


def test_no_connected_account_still_extracts_recipients():
    # Self-echo suppression is best-effort; absence must not lose real mail.
    assert gscan({"From": BOSS, "To": ME}, connected=None).handles == (ME,)


# ── Outlook (Graph) ───────────────────────────────────────────────────────────
def graph_msg(sender, to=(), cc=(), **over):
    msg = {
        "from": {"emailAddress": {"address": sender}},
        "toRecipients": [{"emailAddress": {"address": a}} for a in to],
        "ccRecipients": [{"emailAddress": {"address": a}} for a in cc],
        "conversationId": "conv1",
        "webLink": "https://outlook.office.com/mail/id/1",
    }
    msg.update(over)
    return msg


def oscan(msg, connected=ME):
    return detect_mentions("outlook", msg, connected_account=connected)


def test_outlook_to_and_cc_are_mentions():
    assert oscan(graph_msg(BOSS, to=[ME])).handles == (ME,)
    assert oscan(graph_msg(BOSS, cc=[ME])).handles == (ME,)


def test_outlook_self_echo_is_not_a_mention():
    assert oscan(graph_msg(ME, to=[BOSS])).handles == ()


def test_outlook_missing_recipient_lists_are_safe():
    assert oscan({"from": {"emailAddress": {"address": BOSS}}}).handles == ()


def test_outlook_null_shaped_payload_is_safe():
    # Graph omits keys rather than sending empty ones; none of this may explode.
    assert oscan({}).handles == ()


def test_outlook_thread_ref_and_permalink():
    s = oscan(graph_msg(BOSS, to=[ME]))
    assert s.thread_ref == "conv1"
    assert s.permalink == "https://outlook.office.com/mail/id/1"
