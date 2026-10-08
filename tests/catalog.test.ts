import { describe, expect, it } from 'vitest';
import { deriveStock, fromPesewas, slugify, toPesewas } from '../src/lib/catalog.js';

describe('catalog utilities', () => {
  it('stores GHS values as integer pesewas without losing decimals', () => {
    expect(toPesewas(289.95)).toBe(28_995);
    expect(fromPesewas(28_995)).toBe(289.95);
    expect(() => toPesewas(10.999)).toThrow(/two decimal/);
  });

  it('derives all inventory states at their boundaries', () => {
    expect(deriveStock(0, 5)).toEqual({ inStock: false, stockLevel: 'out_of_stock' });
    expect(deriveStock(5, 5)).toEqual({ inStock: true, stockLevel: 'low_stock' });
    expect(deriveStock(6, 5)).toEqual({ inStock: true, stockLevel: 'in_stock' });
  });

  it('creates stable URL-safe slug candidates', () => {
    expect(slugify('  Héritage Frying Pan! ')).toBe('heritage-frying-pan');
  });
});
