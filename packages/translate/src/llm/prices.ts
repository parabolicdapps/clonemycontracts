import pricesJson from './prices.json' with { type: 'json' };

export interface ModelPrice { provider: string; model: string; label: string; inPerM: number | null; outPerM: number | null; maxOutput?: number }
export interface PriceTable { asOf: string; sources: Record<string, string>; models: ModelPrice[] }

/** the bundled table (prices.json, dated). */
export function loadPrices(): PriceTable { return pricesJson as PriceTable; }

export const priceFor = (provider: string, model: string, table: PriceTable = loadPrices()): ModelPrice | undefined =>
  table.models.find((m) => m.provider === provider && m.model === model);

export interface CostEstimate { usd: number | null; basis: 'reported' | 'table' | 'unknown'; asOf: string; note: string }

/** Estimated USD for a call. A provider-reported cost wins; otherwise tokens x the dated table; otherwise unknown. Always an estimate. */
export function estimateCost(provider: string, model: string, tokensIn: number, tokensOut: number, reportedUsd?: number, table: PriceTable = loadPrices()): CostEstimate {
  const note = 'Estimate from list prices that may be stale; check your provider\'s billing page.';
  if (reportedUsd !== undefined) return { usd: reportedUsd, basis: 'reported', asOf: table.asOf, note: provider === 'claude-cli' ? 'Cost as reported by Claude Code; with a subscription login this is notional, not a charge.' : 'Cost as reported by the provider.' };
  const p = priceFor(provider, model, table);
  if (!p || p.inPerM === null || p.outPerM === null) return { usd: null, basis: 'unknown', asOf: table.asOf, note: 'No price on file for this model.' };
  return { usd: (tokensIn * p.inPerM + tokensOut * p.outPerM) / 1_000_000, basis: 'table', asOf: table.asOf, note };
}
