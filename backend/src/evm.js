import { createPublicClient, createWalletClient, defineChain, fallback, http, formatUnits, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "./config.js";

export const robinhoodChain = defineChain({
  id: config.chainId,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: config.rpcUrls } },
});

// batch: folds concurrent JSON-RPC calls into few HTTP requests (Cloudflare
// rate-limits by request); fallback: hop to the next endpoint on 403/timeouts.
const transport = fallback(
  config.rpcUrls.map((url) => http(url, { batch: { wait: 30 }, retryCount: 2, timeout: 20_000 })),
  { rank: false }
);

export const client = createPublicClient({ chain: robinhoodChain, transport });

export const engineAccount = config.walletPk
  ? privateKeyToAccount(config.walletPk.startsWith("0x") ? config.walletPk : `0x${config.walletPk}`)
  : null;

export const walletClient = engineAccount ? createWalletClient({ account: engineAccount, chain: robinhoodChain, transport }) : null;

export const fromUnits = (wei, decimals = 18) => Number(formatUnits(wei, decimals));
export const toUnits = (n, decimals = 18) => parseUnits(Number(n).toFixed(decimals), decimals);

// ------------------------------------------------------------- ETH/USD price
let ethPriceCache = { price: 0, ts: 0 };
export async function getEthUsd() {
  if (Date.now() - ethPriceCache.ts < 60_000 && ethPriceCache.price > 0) return ethPriceCache.price;
  for (const [url, pick] of [
    ["https://coins.llama.fi/prices/current/coingecko:ethereum", (j) => j?.coins?.["coingecko:ethereum"]?.price],
    ["https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", (j) => j?.ethereum?.usd],
  ]) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const price = Number(pick(await res.json()));
      if (isFinite(price) && price > 0) { ethPriceCache = { price, ts: Date.now() }; return price; }
    } catch { /* next */ }
  }
  return ethPriceCache.price || 0;
}
