import { randomBytes } from 'node:crypto';

export function normalizeWhatsAppNumber(value: string): string {
  const compact = value.trim().replace(/[\s().-]/g, '');
  if (/^0\d{9}$/.test(compact)) return `+233${compact.slice(1)}`;
  if (/^233\d{9}$/.test(compact)) return `+${compact}`;
  if (/^\+[1-9]\d{7,14}$/.test(compact)) return compact;
  return compact;
}

export function createOrderNumber(date = new Date(), suffix = randomBytes(3).toString('hex')): string {
  const day = date.toISOString().slice(0, 10).replaceAll('-', '');
  return `KWM-${day}-${suffix.toUpperCase()}`;
}
