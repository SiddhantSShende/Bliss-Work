-- Phase 2: seed default global pricing. Credit quantities and monthly
-- entitlements are per the business rules (1 credit = $1); reference/current
-- prices are informational (reference = pre-discount list price) and do not
-- themselves drive any charge — the renewal worker (a later phase) charges
-- monthly_credits, not a price. ON CONFLICT DO NOTHING: an operator may have
-- already changed these via the API by the time this runs again.
INSERT INTO billing_pricing (key, value) VALUES
    ('admin_monthly_credits',       '3'),
    ('member_monthly_credits',      '1'),
    ('admin_reference_price_cents', '800'),
    ('member_reference_price_cents','500'),
    ('admin_current_price_cents',   '300'),
    ('member_current_price_cents',  '100')
ON CONFLICT (key) DO NOTHING;
