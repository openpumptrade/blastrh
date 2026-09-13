import { config, mode } from "./config.js";
import { sql, getMeta, setMeta } from "./db.js";
import { client, engineAccount } from "./evm.js";
import { burnAll, curveBuy, poolBuy, quoteBalance, readTotalSupply, refreshPhase, sweepAndClaim, tokenBalanceRaw } from "./pons.js";
import { coin, pot, readPot } from "./tracker.js";
import { ledger } from "./indexer.js";

/// The blaster. Every BLAST_INTERVAL_SEC (3 minutes), on a fixed clock:
///   1. claim 100% of the creator rewards into the engine wallet (sweep + escrow claim)
///   2. ONE market buy of the coin with everything in the wallet (minus gas)
///      — on the bonding curve, or through the Uniswap v4 Universal Router once graduated
///   3. burn every token the wallet holds → total supply goes down
/// Nothing is kept: no ops cut, no team share. A blast too small to be worth
/// a tx rolls into the next one (the ETH stays in the wallet). A failed buy
/// or burn is retried on the next blast — the ETH/tokens are still there.

export const state = {
  nextBlastAt: 0,
  progress: null,      // {status, blastId, dry, pot, claimed, spent, tokens, txs:{claim,buy,burn}, note, at}
  lastNote: null,      // {at, msg}
  blastsRun: 0,
  totalSpentEth: 0,
  totalBurned: 0,
  lastBlast: null,
  genesis: 0,
  dryTotals: { blasts: 0, spentEth: 0, burned: 0 },
};

let launch = null;
let firing = false;
const now = () => Math.floor(Date.now() / 1000);

export async function startBlaster(l) {
  launch = l;
  state.genesis = Number(await getMeta("genesis", 0));
  if (!state.genesis) { state.genesis = now(); await setMeta("genesis", state.genesis); }
  state.nextBlastAt = Number(await getMeta("next_blast_at", 0));
  const note = await getMeta("last_note");
  state.lastNote = note ? JSON.parse(note) : null;
  // a blast interrupted by a restart: close it, the next one picks up whatever is left in the wallet
  await sql`update blasts set status = 'failed', note = coalesce(note, 'interrupted by restart'), finished_at = ${now()} where status in ('claiming', 'buying', 'burning')`;
  await loadHistory();
  if (!state.nextBlastAt || state.nextBlastAt < now() - config.rules.intervalSec) await schedule();
  setInterval(tick, 2_000);
  console.log(`[blaster] ${mode()} mode · every ${config.rules.intervalSec}s · next blast at ${new Date(state.nextBlastAt * 1000).toISOString()}`);
}

async function loadHistory() {
  const [agg] = await sql`select count(*)::int as n, coalesce(sum(spent_eth), 0) as spent, coalesce(sum(tokens_burned), 0) as burned from blasts where status = 'done' and dry = false`;
  const [dry] = await sql`select count(*)::int as n, coalesce(sum(spent_eth), 0) as spent, coalesce(sum(tokens_burned), 0) as burned from blasts where status = 'done' and dry = true`;
  state.blastsRun = agg.n;
  state.totalSpentEth = Number(agg.spent);
  state.totalBurned = Number(agg.burned);
  state.dryTotals = { blasts: dry.n, spentEth: Number(dry.spent), burned: Number(dry.burned) };
  const last = await sql`select * from blasts where status in ('done', 'skipped', 'failed') order by id desc limit 1`;
  state.lastBlast = last.length ? rowToJson(last[0]) : null;
}

/// fixed cadence: the next blast is always genesis + k·interval, so the countdown is predictable
async function schedule() {
  const iv = config.rules.intervalSec;
  const k = Math.floor((now() - state.genesis) / iv) + 1;
  state.nextBlastAt = state.genesis + k * iv;
  await setMeta("next_blast_at", state.nextBlastAt);
}

async function tick() {
  if (firing || !coin.loaded) return;
  if (now() < state.nextBlastAt) return;
  if (!config.schedulerEnabled) { await schedule(); return; }
  firing = true;
  try { await runBlast(); }
  catch (err) {
    const msg = String(err.shortMessage || err.message).slice(0, 160);
    console.error("[blaster] blast failed:", msg);
    await note(`Blast failed: ${msg}`);
    await sql`update blasts set status = 'failed', note = ${msg}, finished_at = ${now()} where status in ('claiming', 'buying', 'burning')`;
    if (state.progress) state.progress = { ...state.progress, status: "failed", note: msg, at: now() };
    await loadHistory();
  }
  finally { await schedule(); firing = false; }
}

async function note(msg) {
  state.lastNote = { at: now(), msg };
  await setMeta("last_note", JSON.stringify(state.lastNote));
}

export function rowToJson(r) {
  return {
    id: r.id, t: r.ts, status: r.status, dry: r.dry, potEth: r.pot_eth, claimedEth: r.claimed_eth, spentEth: r.spent_eth,
    tokensBurned: r.tokens_burned, priceUsd: r.price_usd, ethUsd: r.eth_usd, supplyAfter: r.supply_after, venue: r.venue,
    claimTx: r.claim_tx, buyTx: r.buy_tx, burnTx: r.burn_tx, note: r.note, finishedAt: r.finished_at,
  };
}

const setProgress = (patch) => { state.progress = { ...(state.progress || {}), ...patch, at: now() }; };
const priceUsdNow = () => (ledger.price && coin.usdPerQuote ? ledger.price * coin.usdPerQuote : null);
const venueOf = () => (launch.phase === 2 ? "uniswap" : launch.phase === 1 ? "pending-pool" : "curve");

export async function runBlast() {
  const dry = mode() !== "bot" || config.dryRun;
  await refreshPhase(launch).catch(() => {});
  await readPot().catch(() => {});
  const claimable = pot.escrowEth;            // exact: what the escrow will hand over on claim()
  const unswept = pot.unsweptEth;             // upper bound: still on the curve/hook, pons keeps its split
  const leftover = pot.spendableEth;          // ETH already in the wallet from a previous small/failed blast
  const leftoverTokens = pot.walletTokens;    // tokens from a previous failed burn
  const potTotal = claimable + (dry ? 0 : leftover);
  const ts = now();
  const [{ id }] = await sql`insert into blasts (ts, status, dry, pot_eth, price_usd, eth_usd, venue) values (${ts}, 'claiming', ${dry}, ${potTotal}, ${priceUsdNow()}, ${coin.usdPerQuote}, ${venueOf()}) returning id`;
  setProgress({ status: "claiming", blastId: id, dry, pot: potTotal, claimed: 0, spent: 0, tokens: 0, txs: {}, note: null });
  console.log(`[blaster] 💥 blast #${id} · escrow ${claimable.toFixed(5)} ETH + unswept ${unswept.toFixed(5)} ETH + wallet ${leftover.toFixed(5)} ETH${leftoverTokens ? ` + ${leftoverTokens.toLocaleString()} tokens unburned` : ""}${dry ? " · DRY" : ""}`);

  if (dry) {
    const wouldSpend = claimable;
    const est = pot.estTokens && potTotal > 0 ? (pot.estTokens * wouldSpend) / potTotal : 0;
    const status = wouldSpend >= config.rules.minBuyEth ? "done" : "skipped";
    const msg = status === "done"
      ? `would claim ${wouldSpend.toFixed(5)} ETH, buy ≈ ${Math.round(est).toLocaleString()} $${launch.symbol} on ${venueOf()} and burn them`
      : `claimable ${wouldSpend.toFixed(5)} ETH under the ${config.rules.minBuyEth} ETH minimum — rolls over`;
    await sql`update blasts set status = ${status}, claimed_eth = ${wouldSpend}, spent_eth = ${wouldSpend}, tokens_burned = ${est}, venue = ${venueOf()}, note = ${msg}, finished_at = ${now()} where id = ${id}`;
    setProgress({ status, claimed: wouldSpend, spent: wouldSpend, tokens: est, note: msg });
    await loadHistory();
    console.log(`[blaster] (dry) ${msg}`);
    return;
  }

  const me = engineAccount.address;
  const txs = {};
  const dq = 10 ** launch.quoteDecimals;

  // 1. claim — sweep what the curve/hook lets the creator sweep, then claim the whole escrow
  let claimed = 0;
  if (claimable + unswept >= config.rules.minClaimEth) {
    const before = await quoteBalance(launch, me);
    const { txs: claimTxs } = await sweepAndClaim(launch);
    if (claimTxs.length) {
      txs.claim = claimTxs[claimTxs.length - 1];
      const after = await quoteBalance(launch, me);
      claimed = Math.max(0, after - before);
      console.log(`[blaster] claimed ${claimed.toFixed(5)} ${launch.quoteSymbol} · ${claimTxs.join(", ")}`);
    }
  }
  const walletQuote = await quoteBalance(launch, me);
  const gasEth = launch.native ? walletQuote : Number(await client.getBalance({ address: me })) / 1e18;
  const spend = launch.native ? Math.max(0, walletQuote - config.rules.gasReserveEth) : (gasEth >= config.rules.gasReserveEth ? walletQuote : 0);
  await sql`update blasts set claimed_eth = ${claimed}, claim_tx = ${txs.claim || null}, status = 'buying' where id = ${id}`;
  setProgress({ status: "buying", claimed, txs: { ...txs } });

  // 2. one buy with all of it
  let buyTx = "", venue = "";
  if (spend >= config.rules.minBuyEth) {
    const quoteIn = BigInt(Math.floor(spend * dq));
    await refreshPhase(launch).catch(() => {});
    if (launch.phase === 1) {
      throw new Error("launch is swept but the Uniswap pool is not seeded yet — buys wait for createGraduatedPool");
    }
    try {
      if (launch.phase === 2) { venue = "uniswap"; ({ hash: buyTx } = await poolBuy(launch, quoteIn)); }
      else { venue = "curve"; ({ hash: buyTx } = await curveBuy(launch, quoteIn)); }
    } catch (err) {
      if (venue === "curve" && /CurveGraduated|graduated/i.test(String(err.shortMessage || err.message))) {
        console.warn("[blaster] curve refused the buy — the launch graduated, routing through the Universal Router");
        await refreshPhase(launch).catch(() => {});
        venue = "uniswap"; ({ hash: buyTx } = await poolBuy(launch, quoteIn));
      } else throw err;
    }
    txs.buy = buyTx;
    console.log(`[blaster] bought with ${spend.toFixed(5)} ${launch.quoteSymbol} on ${venue} · ${buyTx}`);
  }
  const walletAfterBuy = await quoteBalance(launch, me);
  const spent = buyTx ? Math.max(0, walletQuote - walletAfterBuy) : 0;
  await sql`update blasts set spent_eth = ${spent}, buy_tx = ${buyTx || null}, venue = ${venue || venueOf()}, status = 'burning' where id = ${id}`;
  setProgress({ status: "burning", spent, txs: { ...txs } });

  // 3. burn everything the wallet holds (this buy + anything a previous blast failed to burn)
  const held = Number(await tokenBalanceRaw(launch, me)) / 1e18;
  let burned = 0;
  if (held > 0) {
    const { hash, amount } = await burnAll(launch);
    txs.burn = hash; burned = Number(amount) / 1e18;
    console.log(`[blaster] 🔥 burned ${burned.toLocaleString()} $${launch.symbol} · ${hash}`);
  }
  const supplyAfter = await readTotalSupply(launch).catch(() => null);
  const status = buyTx || burned > 0 ? "done" : "skipped";
  const msg = status === "done"
    ? `claimed ${claimed.toFixed(5)} ETH · bought with ${spent.toFixed(5)} ETH on ${venue} · burned ${Math.round(burned).toLocaleString()} $${launch.symbol}`
    : `${spend.toFixed(5)} ETH available, under the ${config.rules.minBuyEth} ETH minimum — rolls into the next blast`;
  await sql`update blasts set status = ${status}, tokens_burned = ${burned}, burn_tx = ${txs.burn || null}, supply_after = ${supplyAfter}, eth_usd = ${coin.usdPerQuote}, price_usd = ${priceUsdNow()}, note = ${msg}, finished_at = ${now()} where id = ${id}`;
  setProgress({ status, tokens: burned, txs: { ...txs }, note: msg });
  if (supplyAfter !== null) { coin.supply = supplyAfter; coin.burned = Math.max(0, coin.supply0 - supplyAfter) + coin.deadTokens; }
  await readPot().catch(() => {});
  await loadHistory();
  console.log(`[blaster] ✅ blast #${id} ${status}: ${msg}`);
}
