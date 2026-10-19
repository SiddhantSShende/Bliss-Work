/** Format an integer cents amount as a localized currency string. Billing
 *  amounts are always whole-dollar (1 credit = $1) but packages/pricing are
 *  stored in cents for headroom, so this is the one place that divides. */
export function formatCents(cents: number, currency = "usd"): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(
    cents / 100,
  );
}
