import { useState } from "react";
import { Link } from "react-router-dom";
import { Eye, X } from "lucide-react";

/**
 * Tells members, in the product, that their activity is recorded.
 *
 * This is not decoration. Monitoring people without telling them is unlawful in
 * much of the world (the UK/EU need a lawful basis and notice; India's DPDP
 * requires notice; several US states require consent), and it is corrosive
 * regardless of the law. The bargain this product makes is: everything recorded
 * about you is visible to you.
 *
 * Dismissible, because a banner that cannot be dismissed gets ignored — but the
 * link into the member's own record stays permanently in Settings, so dismissing
 * hides the reminder, never the access.
 */
const SEEN_KEY = "tb:activity-notice-seen";

export function ActivityNotice() {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(SEEN_KEY) === "1";
    } catch {
      // Private mode / storage disabled: show the notice rather than suppress
      // it. Failing towards MORE disclosure is the right default here.
      return false;
    }
  });

  if (dismissed) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(SEEN_KEY, "1");
    } catch {
      /* storage unavailable — dismiss for this session only */
    }
    setDismissed(true);
  };

  return (
    <div className="mx-2 mt-2 flex items-start gap-2 rounded-xl bg-accent-soft px-3 py-2.5 text-xs leading-relaxed text-accent">
      <Eye size={14} className="mt-0.5 shrink-0" />
      <p className="min-w-0 flex-1">
        Your activity in BlissWork is recorded so you and your workspace admins can
        review it.{" "}
        <Link to="/app/settings/activity" className="font-semibold underline underline-offset-2">
          See what's recorded
        </Link>
      </p>
      <button
        onClick={dismiss}
        aria-label="Dismiss"
        className="shrink-0 rounded-md p-0.5 opacity-70 transition hover:bg-accent/10 hover:opacity-100"
      >
        <X size={14} />
      </button>
    </div>
  );
}
