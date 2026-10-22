import { afterEach, describe, expect, it } from 'vitest';
import { getEnvironment, resetEnvironmentForTests } from '../src/config/environment.js';

const managedKeys = [
  'STORE_CONTACT_EMAIL',
  'STORE_CONTACT_PHONE',
  'STORE_CONTACT_WHATSAPP_URL',
  'STORE_DELIVERY_POLICY',
  'STORE_PAYMENT_POLICY',
  'STORE_RETURN_POLICY',
  'STOREFRONT_PRODUCT_URL_TEMPLATE',
] as const;
const originals = new Map(managedKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of managedKeys) {
    const original = originals.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  resetEnvironmentForTests();
});

describe('optional store configuration', () => {
  it('normalizes blank documented settings to undefined', () => {
    process.env.STORE_CONTACT_EMAIL = '   ';
    process.env.STORE_CONTACT_PHONE = '';
    process.env.STORE_CONTACT_WHATSAPP_URL = '\t';
    process.env.STORE_DELIVERY_POLICY = '';
    process.env.STORE_PAYMENT_POLICY = '  ';
    process.env.STORE_RETURN_POLICY = '';
    process.env.STOREFRONT_PRODUCT_URL_TEMPLATE = '';
    resetEnvironmentForTests();

    const environment = getEnvironment();
    for (const key of managedKeys) expect(environment[key]).toBeUndefined();
  });

  it('continues rejecting invalid nonblank email addresses and URLs', () => {
    process.env.STORE_CONTACT_EMAIL = 'not-an-email';
    resetEnvironmentForTests();
    expect(() => getEnvironment()).toThrow();

    process.env.STORE_CONTACT_EMAIL = 'store@example.com';
    process.env.STORE_CONTACT_WHATSAPP_URL = 'not-a-url';
    resetEnvironmentForTests();
    expect(() => getEnvironment()).toThrow();
  });
});
