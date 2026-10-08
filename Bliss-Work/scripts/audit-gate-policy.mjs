export function expiredAllowlistEntries(entries, today = new Date().toISOString().slice(0, 10)) {
  return entries.filter(({ reviewBy }) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reviewBy)) return true;
    const parsed = new Date(`${reviewBy}T00:00:00.000Z`);
    return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== reviewBy || reviewBy < today;
  });
}
