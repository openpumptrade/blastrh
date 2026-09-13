import { config, mode } from "./config.js";
import { getMeta, setMeta } from "./db.js";
import { client, engineAccount } from "./evm.js";
import { curveProgress, deadBalance, escrowQuote, quoteBalance, quoteBuy, readTotalSupply, refreshPhase, tokenBalanceRaw, unsweptQuote } from "./pons.js";
import { getQuoteUsd } from "./price.js";
import { ledger } from "./indexer.js";

/// Market + pot tracker. Every POLL_SEC it refreshes the launch phase, the
/// total supply (it shrinks with every burn), the unclaimed creator rewards
/// (the pot) and the engine wallet's balances. Prices come from the indexer.

export const coin = {
  loaded: false, supply: 0, supply0: 0, burned: 0, deadTokens: 0, usdPerQuote: 0, progress: 0, updatedAt: 0,
};
export const pot = {
  unsweptEth: 0,   // fees still sitting on the curve / hook (upper bound — the protocol keeps its split)
  escrowEth: 0,    // already credited to the engine wallet in the fee escrow (exact, claimable)
  walletEth: 0, spendableEth: 0, walletTokens: 0, estTokens: 0, updatedAt: 0, error: null,
};

let launch = null;
let wallet = "";
let running = false;

export function engineWallet() { return wallet; }

export async function loadCoin(l) {
  launch = l;
  wallet = engineAccount ? engineAccount.address.toLowerCase() : (config.walletAddress || launch.creatorFeeRecipient);
  if (engineAccount && wallet !== launch.creatorFeeRecipient) {
    console.warn(`[tracker] WARNING: WALLET_PRIVATE_KEY is ${wallet} but the launch pays creator fees to ${launch.creatorFeeRecipient} — claims will find nothing`);
  }
  coin.supply = await readTotalSupply(launch);
  const s0 = Number(await getMeta("supply0", 0));
  coin.supply0 = s0 || coin.supply;
  if (!s0) await setMeta("supply0", coin.supply0);
  coin.deadTokens = launch.canBurn ? 0 : await deadBalance(launch);
  coin.burned = Math.max(0, coin.supply0 - coin.supply) + coin.deadTokens;
  coin.loaded = true;
  return coin;
}

export async function startTracker() {
  await tick();
  setInterval(tick, config.pollSec * 1000);
  console.log(`[tracker] ${launch.name} ($${launch.symbol}) · ${launch.phase === 2 ? "graduated · Uniswap v4" : launch.phase === 1 ? "swept · pool pending" : "on the curve"} · supply ${coin.supply.toLocaleString()} · ${launch.canBurn ? "burn()" : "0xdead"} · polling every ${config.pollSec}s`);
}

export async function readPot() {
  const [unswept, escrow, walletEth, tokensRaw] = await Promise.all([
    unsweptQuote(launch),
    escrowQuote(launch, wallet).catch((e) => { pot.error = String(e.shortMessage || e.message).slice(0, 120); return pot.escrowEth; }),
    quoteBalance(launch, wallet).catch(() => pot.walletEth),
    tokenBalanceRaw(launch, wallet).catch(() => 0n),
  ]);
  pot.unsweptEth = unswept;
  pot.escrowEth = escrow;
  pot.walletEth = walletEth;
  pot.spendableEth = Math.max(0, walletEth - config.rules.gasReserveEth);
  pot.walletTokens = Number(tokensRaw) / 1e18;
  const est = escrow + (mode() === "bot" ? pot.spendableEth : 0);
  if (est > 0) {
    try { pot.estTokens = Number(await quoteBuy(launch, BigInt(Math.floor(est * 10 ** launch.quoteDecimals)), wallet)) / 1e18; }
    catch { /* keep the previous estimate */ }
  } else pot.estTokens = 0;
  pot.updatedAt = Math.floor(Date.now() / 1000);
  return pot;
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const [supply, usd, progress] = await Promise.all([
      readTotalSupply(launch).catch(() => coin.supply),
      getQuoteUsd(launch),
      launch.phase === 0 ? curveProgress(launch) : Promise.resolve(1),
    ]);
    await refreshPhase(launch).catch(() => {});
    coin.supply = supply;
    if (!launch.canBurn) coin.deadTokens = await deadBalance(launch).catch(() => coin.deadTokens);
    coin.burned = Math.max(0, coin.supply0 - coin.supply) + coin.deadTokens;
    coin.usdPerQuote = usd;
    coin.progress = progress;
    coin.updatedAt = Math.floor(Date.now() / 1000);
    await readPot();
  } catch (err) {
    console.error("[tracker] tick:", String(err.shortMessage || err.message).slice(0, 200));
  } finally { running = false; }
}

export function priceQuote() { return ledger.price; }
export { client };
