import { config } from "./config.js";
import { getEthUsd } from "./evm.js";

/// USD per unit of the quote asset. Native → ETH price; custom pair → the
/// quoteUsd pons publishes on its own market feed (cached), env override last.
let cache = { price: 0, ts: 0 };

export async function getQuoteUsd(launch) {
  if (config.quoteUsdOverride > 0) return config.quoteUsdOverride;
  if (launch.native) return getEthUsd();
  if (Date.now() - cache.ts < 60_000 && cache.price > 0) return cache.price;
  try {
    const res = await fetch(`${config.ponsSiteUrl}/api/pons-v2-market/${launch.token}/chart?range=5m`, {
      headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128 Safari/537.36", accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const json = await res.json();
      const p = Number(json?.quoteUsd);
      if (isFinite(p) && p > 0) cache = { price: p, ts: Date.now() };
    }
  } catch { /* keep stale */ }
  return cache.price || 0;
}
