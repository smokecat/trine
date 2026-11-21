/**
 * 成本显示币种：全局开关（USD / CNY），只影响显示，不改 agent 上报的数值。
 *
 * agent 侧的成本一律以美元计算（`~/.trine/pricing.json` 用 USD / 百万 token
 * 计价），这里按一个估算汇率换算成人民币。点一下成本数字就在两种币种间切换，
 * 选择存 localStorage，对所有页面、所有会话生效。
 *
 * 汇率不是实时行情：默认 7.1，可在 localStorage 的 `trine.usdToCny` 覆盖
 * （例如 DeepSeek 官方人民币价目折算出来约 6.7，GLM 按 7.1 进货时用 7.1）。
 */
import { useSyncExternalStore } from 'react';

export type CostCurrency = 'USD' | 'CNY';

const CURRENCY_KEY = 'trine.costCurrency';
const FX_KEY = 'trine.usdToCny';
const DEFAULT_USD_TO_CNY = 7.1;

const listeners = new Set<() => void>();

function stored(): string | null {
  try {
    return localStorage.getItem(CURRENCY_KEY);
  } catch {
    return null; // 隐私模式 / 非浏览器环境
  }
}

function initial(): CostCurrency {
  return stored() === 'CNY' ? 'CNY' : 'USD';
}

let current: CostCurrency = initial();

function emit(): void {
  for (const listener of listeners) listener();
}

/** 美元 → 人民币的估算汇率 */
export function usdToCny(): number {
  try {
    const raw = Number(localStorage.getItem(FX_KEY));
    if (Number.isFinite(raw) && raw > 0) return raw;
  } catch {
    /* 用默认值 */
  }
  return DEFAULT_USD_TO_CNY;
}

export function getCostCurrency(): CostCurrency {
  return current;
}

export function setCostCurrency(currency: CostCurrency): void {
  if (currency === current) return;
  current = currency;
  try {
    localStorage.setItem(CURRENCY_KEY, currency);
  } catch {
    /* 存不了就只在内存里生效 */
  }
  emit();
}

/** 在 USD / CNY 之间切换（成本数字的点击行为） */
export function toggleCostCurrency(): void {
  setCostCurrency(current === 'USD' ? 'CNY' : 'USD');
}

export function subscribeCostCurrency(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 组件里读当前币种；切换时自动重渲染 */
export function useCostCurrency(): CostCurrency {
  return useSyncExternalStore(subscribeCostCurrency, getCostCurrency, () => 'USD');
}

/**
 * 成本格式化：`$0.21` / `¥1.49`。口径与 format.ts 的 formatCost 一致——
 * 非 0 但四舍五入成 0 的给 `<¥0.01`，避免看起来像「没花钱」。
 */
export function formatCostIn(usd: number, currency: CostCurrency): string {
  const value = currency === 'CNY' ? usd * usdToCny() : usd;
  const symbol = currency === 'CNY' ? '¥' : '$';
  if (!Number.isFinite(value) || value === 0) return `${symbol}0.00`;
  if (value > 0 && value < 0.005) return `<${symbol}0.01`;
  return `${symbol}${value.toFixed(2)}`;
}
