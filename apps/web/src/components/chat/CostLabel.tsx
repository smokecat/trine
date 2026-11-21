/**
 * 可点击的成本数字：点一下在人民币 / 美元之间切换（全局生效，存 localStorage）。
 *
 * 用在完成卡与会话状态卡里——远程场景看不见终端账单，成本数字是唯一的
 * 花费感知；点它切换币种比去设置里找开关更顺手。
 */
import { formatCostIn, toggleCostCurrency, useCostCurrency } from '@/lib/currency.ts';

export function CostLabel({
  usd,
  className,
}: {
  usd: number;
  className?: string;
}): React.JSX.Element {
  const currency = useCostCurrency();
  return (
    <button
      type="button"
      data-testid="cost-label"
      data-currency={currency}
      title={`点击切换币种（当前${currency === 'CNY' ? '人民币' : '美元'}）`}
      className={`cursor-pointer underline decoration-dotted underline-offset-2 hover:text-text ${className ?? ''}`}
      onClick={(event) => {
        event.stopPropagation();
        toggleCostCurrency();
      }}
    >
      {formatCostIn(usd, currency)}
    </button>
  );
}
