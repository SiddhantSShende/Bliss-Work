"""The ONE list of characters a CAPTCHA can contain.

`captcha_service._generate_value` is the only generator and draws from
`ALPHABET`; nothing else in the service (or any client) builds a value. A
character is added or removed here and nowhere else.

The answer stays CASE-SENSITIVE and uses both cases — only characters a person
cannot reliably tell apart in the distorted image are left out.

Excluded, and why
  * look-alikes in the CAPTCHA font:   0 O o   1 I i l L   2 Z z   5 S s
  * same outline, only the SIZE differs between the cases:  W w   X x   C c   V v
    For these the lower-case letter is just a ~27% smaller upper-case one, and
    a CAPTCHA that is deliberately a little noisy hides exactly that cue (a
    string of all-lower or all-upper letters has nothing to compare against).
  * dropped after rendering review, with the real font and pipeline:
      K k  — the same height and nearly the same shape, differing only in
             where the arms meet the stem.
      J j  — once rotated and rippled, the j's small dot is lost among the noise
             and J/j read alike.

Kept after the same review, with the cue that separates them
  B b G g 6  (and their usual confusers 8 9 q h): a flat stem vs two bowls (B/8),
  a hooked descender (g/9/q), an ascender with the bowl low (b/6/h) — all
  clear after rotation and ripple.
  P p, Y y: the lower-case letter hangs below the baseline.  U u: the lower-case
  letter has a spur on its right side.

How the review was done: every character of A-Z a-z 0-9 was drawn through
`captcha_image.render` (the real font, rotation, noise and ripple) and
compared with clean templates; pairs were ranked by outline similarity, then
reviewed by eye on rendered sheets. The look-alikes above ranked at the top of
that list, which is what validated the method. V/v and J/j ranked first and
sixth, above several of them.
"""
from __future__ import annotations

UPPERCASE = "ABDEFGHMNPQRTUY"
LOWERCASE = "abdefghmnpqrtuy"
DIGITS = "346789"

ALPHABET = UPPERCASE + LOWERCASE + DIGITS

# Asserted by the tests: none of these may ever be generated.
EXCLUDED = frozenset("0Oo" "1IilL" "2Zz" "5Ss" "Ww" "Xx" "Cc" "Vv" "Kk" "Jj")
