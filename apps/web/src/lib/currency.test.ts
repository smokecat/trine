/**
 * 币种显示开关：默认美元、切换持久化（这里只验内存态）、换算与格式。
 * localStorage 在 bun test 里不存在，模块内已做降级，正好覆盖该路径。
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  formatCostIn,
  getCostCurrency,
  setCostCurrency,
  toggleCostCurrency,
  usdToCny,
} from './currency.ts';

beforeEach(() => {
  setCostCurrency('USD');
});

describe('cost currency', () => {
  test('默认美元', () => {
    expect(getCostCurrency()).toBe('USD');
  });

  test('切换在 USD / CNY 之间往返', () => {
    toggleCostCurrency();
    expect(getCostCurrency()).toBe('CNY');
    toggleCostCurrency();
    expect(getCostCurrency()).toBe('USD');
  });

  test('美元格式与 formatCost 一致', () => {
    expect(formatCostIn(0, 'USD')).toBe('$0.00');
    expect(formatCostIn(0.213, 'USD')).toBe('$0.21');
    expect(formatCostIn(0.001, 'USD')).toBe('<$0.01');
  });

  test('人民币按汇率换算（默认 7.1）', () => {
    expect(usdToCny()).toBeCloseTo(7.1, 6);
    expect(formatCostIn(1, 'CNY')).toBe('¥7.10');
    expect(formatCostIn(0.1, 'CNY')).toBe('¥0.71');
  });

  test('人民币的小额档位', () => {
    expect(formatCostIn(0, 'CNY')).toBe('¥0.00');
    expect(formatCostIn(0.0001, 'CNY')).toBe('<¥0.01');
  });
});
