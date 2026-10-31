/** Decimal entry stays textual so trailing decimal points and cents are preserved. */
export function amountKey(value: string, key: string): string {
  if (key === 'delete') return value.slice(0, -1);
  if (key === 'clear') return '';
  if (key === '.') return value.includes('.') ? value : `${value || '0'}.`;
  if (!/^\d$/.test(key)) return value;
  const [whole, fraction] = value.split('.');
  if (fraction !== undefined) return fraction.length < 2 ? value + key : value;
  if (whole === '0') return key;
  return whole.length < 14 ? value + key : value;
}
