"""Pure-logic half of connection verification: code shape, hashing, reply parsing.

The DB-backed half (single use, expiry, attempt cap, the webhook round trip)
lives in tests/integration/test_whatsapp_verification.py — none of those
properties can be proven without a real Postgres.
"""
from app import verification
from app.providers import whatsapp


def test_new_code_is_six_digits():
    for _ in range(200):
        c = verification.new_code()
        assert len(c) == 6 and c.isdigit()


def test_hash_is_salted_per_connection():
    """The same code under two connections must not share a digest — six digits
    is a tiny space, and an unsalted hash would let one precomputed table cover
    every row in the table at once."""
    a = verification._hash("conn-a", "123456")
    b = verification._hash("conn-b", "123456")
    assert a != b
    assert verification._hash("conn-a", "123456") == a  # deterministic


def test_hash_does_not_contain_the_code():
    assert b"123456" not in verification._hash("conn-a", "123456")


def test_extract_reply_code_accepts_what_people_actually_type():
    assert verification.extract_reply_code("CONFIRM 482193") == "482193"
    assert verification.extract_reply_code("confirm-000123") == "000123"
    assert verification.extract_reply_code("Confirm: 999999") == "999999"
    # Autocorrect eats the separator often enough to be worth tolerating.
    assert verification.extract_reply_code("CONFIRM482193") == "482193"
    # And people top-and-tail it with pleasantries.
    assert verification.extract_reply_code("hi, CONFIRM 482193 thanks") == "482193"


def test_extract_reply_code_ignores_unrelated_messages():
    assert verification.extract_reply_code("hello there") is None
    assert verification.extract_reply_code("482193") is None  # no keyword
    assert verification.extract_reply_code("CONFIRM 12345") is None  # too short
    assert verification.extract_reply_code("") is None
    assert verification.extract_reply_code(None) is None  # type: ignore[arg-type]


def test_reengagement_error_is_distinguished_from_a_bad_token():
    """The template/reply fallback must fire ONLY for a closed 24h window. If it
    swallowed an auth failure, a bad token would present as 'message us
    instead' and the admin would never learn what was actually wrong."""
    assert whatsapp.is_reengagement_error(
        whatsapp.WhatsAppError("400: (#131047) Message failed to send because more than 24 hours "
                               "have passed since the customer last replied")
    )
    assert whatsapp.is_reengagement_error(whatsapp.WhatsAppError("400: (#470) re-engagement message"))
    assert not whatsapp.is_reengagement_error(
        whatsapp.WhatsAppError("401: Invalid OAuth access token")
    )
    assert not whatsapp.is_reengagement_error(
        whatsapp.WhatsAppError("400: Invalid parameter: recipient phone number not valid")
    )
