export function formatNaira(amount: string | number | null | undefined): string {
  if (amount == null) return '—';
  const raw = String(amount).trim();
  if (raw === '' || raw === '—') return '—';
  const n = Number(raw.replace(/,/g, ''));
  if (!Number.isFinite(n)) return '—';
  return '₦' + n.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
