import { parseAbiItem } from "viem";
import { sql, getMeta, setMeta } from "./db.js";
import { config } from "./config.js";
import { client } from "./evm.js";
import { CURVE_ABI, ERC20_ABI, POOL_MANAGER_ABI, curveSpot, priceFromSqrt, refreshPhase } from "./pons.js";

/// On-chain indexer — no pons service in the loop. Every few seconds it pulls:
///   · CurveBuy / CurveSell on the launch's curve      (pre-graduation trades)
///   · Swap on the Uniswap v4 PoolManager for the poolId (post-graduation trades)
///   · Transfer on the launch token                      (who still holds what)
/// into an in-memory ledger (mirrored to Postgres) that positions.js reads.

export const ledger = {
  trades: [],     // {tx, logIndex, block, t, wallet, side, venue, quote, tokens, price}
  transfers: [],  // {tx, logIndex, block, t, from, to, value}
  lastBlock: 0,
  version: 0,
  price: null,          // quote per token
  priceUpdatedAt: 0,
  lastTradeAt: 0,
  syncing: true,
};

let launch = null;
let system = new Set();
const routers = new Set(); // swap senders we could not see through, learned at index time
let running = false;
let span = 4000n;

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const SWAP = POOL_MANAGER_ABI[0];
const CURVE_EVENTS = CURVE_ABI.filter((x) => x.type === "event");

export function systemSet() { return system; }

export async function startIndexer(l) {
  launch = l;
  system = new Set([
    ...config.ponsSystem, ...config.excludedExtra,
    launch.curve, launch.token, launch.pairToken, launch.creatorFeeRecipient, launch.deployer,
    ...(config.walletAddress ? [config.walletAddress] : []),
  ]);
  // a different token than the one this database was built for → start clean
  const prev = await getMeta("token", "");
  if (prev && prev !== launch.token) {
    console.warn(`[indexer] database was indexed for ${prev}, now ${launch.token} — resetting the ledger`);
    await sql`truncate trades, transfers, blasts restart identity`;
    await sql`delete from meta`;
  }
  await setMeta("token", launch.token);
  for (const r of String(await getMeta("routers", "")).split(",").filter(Boolean)) { system.add(r); routers.add(r); }
  await loadLedger();
  if (!ledger.lastBlock) {
    const from = await findLaunchBlock();
    ledger.lastBlock = from - 1;
    await setMeta("last_block", ledger.lastBlock);
    console.log(`[indexer] starting from block ${from}`);
  }
  const p = await getMeta("price");
  if (p) { ledger.price = Number(p); ledger.priceUpdatedAt = Number(await getMeta("price_at", 0)); }
  await tick();
  setInterval(tick, config.indexMs);
  setInterval(() => refreshPhase(launch).catch(() => {}), 60_000);
  console.log(`[indexer] ${ledger.trades.length} trades · ${ledger.transfers.length} transfers loaded · polling every ${config.indexMs / 1000}s`);
}

async function loadLedger() {
  const t = await sql`select tx, log_index, block, ts, wallet, side, venue, quote, tokens, price from trades order by block, log_index`;
  ledger.trades = t.map((r) => ({ tx: r.tx, logIndex: r.log_index, block: Number(r.block), t: r.ts, wallet: r.wallet, side: r.side, venue: r.venue, quote: r.quote, tokens: r.tokens, price: r.price }));
  const x = await sql`select tx, log_index, block, ts, "from", "to", value from transfers order by block, log_index`;
  ledger.transfers = x.map((r) => ({ tx: r.tx, logIndex: r.log_index, block: Number(r.block), t: r.ts, from: r.from, to: r.to, value: r.value }));
  ledger.lastBlock = Number(await getMeta("last_block", 0));
  ledger.lastTradeAt = ledger.trades.length ? ledger.trades[ledger.trades.length - 1].t : 0;
  ledger.version++;
}

/// Block the token was minted in: env → Blockscout → walk back through Transfer logs.
async function findLaunchBlock() {
  if (config.launchBlock) return config.launchBlock;
  try {
    const res = await fetch(`${config.explorer}/api/v2/addresses/${launch.token}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    const j = await res.json();
    const hash = j?.creation_transaction_hash || j?.creation_tx_hash;
    if (hash) { const r = await client.getTransactionReceipt({ hash }); return Number(r.blockNumber); }
  } catch { /* fall through */ }
  const head = await client.getBlockNumber();
  let to = head, step = 50_000n;
  for (let i = 0; i < 400; i++) {
    const from = to - step + 1n > 0n ? to - step + 1n : 0n;
    let logs;
    try {
      logs = await client.getLogs({ address: launch.token, event: TRANSFER, args: { from: "0x0000000000000000000000000000000000000000" }, fromBlock: from, toBlock: to });
    } catch { step = step / 2n > 1000n ? step / 2n : 1000n; continue; }
    if (logs.length) return Number(logs[0].blockNumber);
    if (from === 0n) break;
    to = from - 1n;
  }
  throw new Error("could not find the launch block — set LAUNCH_BLOCK");
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const head = Number(await client.getBlockNumber());
    while (ledger.lastBlock < head) {
      const from = BigInt(ledger.lastBlock + 1);
      let to = from + span - 1n;
      if (to > BigInt(head)) to = BigInt(head);
      try {
        await indexRange(from, to);
        ledger.lastBlock = Number(to);
        await setMeta("last_block", ledger.lastBlock);
        if (span < 8_000n) span = span * 2n; // public RPCs reject wider eth_getLogs windows
      } catch (err) {
        // public RPCs cap the number of logs per call: shrink the window and
        // retry right away instead of waiting for the next tick
        if (span <= 200n) { console.warn(`[indexer] range ${from}-${to} keeps failing: ${String(err.shortMessage || err.message).slice(0, 100)}`); break; }
        span = span / 2n > 200n ? span / 2n : 200n;
        continue;
      }
    }
    ledger.syncing = ledger.lastBlock < head - 200;
    await refreshSpot();
  } catch (err) {
    console.error("[indexer] tick:", err.message);
  } finally {
    running = false;
  }
}

const tsCache = new Map();
async function blockTs(blockNumber) {
  const k = blockNumber.toString();
  if (tsCache.has(k)) return tsCache.get(k);
  const b = await client.getBlock({ blockNumber });
  if (tsCache.size > 20_000) tsCache.clear();
  tsCache.set(k, Number(b.timestamp));
  return Number(b.timestamp);
}

/// Timestamps for a set of blocks. During backfill a range holds thousands of
/// blocks, so fetch up to 60 evenly spaced anchors (always first and last) and
/// interpolate the rest by block number — a few seconds off at worst. Live
/// polling touches a handful of blocks, all of which become anchors.
async function resolveTimestamps(blockNumbers) {
  const need = blockNumbers.filter((b) => !tsCache.has(String(b))).sort((a, c) => a - c);
  if (!need.length) return;
  const MAX = 60;
  const anchors = need.length <= MAX ? need : Array.from({ length: MAX }, (_, i) => need[Math.round((i * (need.length - 1)) / (MAX - 1))]);
  const uniq = [...new Set(anchors)];
  await Promise.all(uniq.map((b) => blockTs(BigInt(b))));
  if (need.length <= MAX) return;
  let k = 0;
  for (const b of need) {
    if (tsCache.has(String(b))) continue;
    while (k < uniq.length - 2 && uniq[k + 1] < b) k++;
    const b0 = uniq[k], b1 = uniq[k + 1], t0 = tsCache.get(String(b0)), t1 = tsCache.get(String(b1));
    const t = b1 === b0 ? t0 : Math.round(t0 + ((b - b0) * (t1 - t0)) / (b1 - b0));
    tsCache.set(String(b), t);
  }
}

async function indexRange(from, to) {
  const [curveLogs, transferLogs, swapLogs] = await Promise.all([
    launch.phase === 0 || true ? client.getLogs({ address: launch.curve, events: CURVE_EVENTS, fromBlock: from, toBlock: to }) : [],
    client.getLogs({ address: launch.token, event: TRANSFER, fromBlock: from, toBlock: to }),
    client.getLogs({ address: config.poolManager, event: SWAP, args: { id: launch.poolId }, fromBlock: from, toBlock: to }),
  ]);
  if (!curveLogs.length && !transferLogs.length && !swapLogs.length) return;

  await resolveTimestamps([...new Set([...curveLogs, ...transferLogs, ...swapLogs].map((l) => Number(l.blockNumber)))]);

  const dq = 10 ** launch.quoteDecimals;
  const newTrades = [], newTransfers = [];
  const byTx = new Map(); // token transfers per tx (for attributing pool swaps)
  for (const l of transferLogs) {
    const x = { tx: l.transactionHash, logIndex: l.logIndex, block: Number(l.blockNumber), t: tsCache.get(l.blockNumber.toString()), from: l.args.from.toLowerCase(), to: l.args.to.toLowerCase(), value: Number(l.args.value) / 1e18 };
    newTransfers.push(x);
    if (!byTx.has(x.tx)) byTx.set(x.tx, []);
    byTx.get(x.tx).push(x);
  }
  for (const l of curveLogs) {
    const isBuy = l.eventName === "CurveBuy";
    const quote = Number(isBuy ? l.args.quoteIn : l.args.quoteOut) / dq;
    const tokens = Number(isBuy ? l.args.tokensOut : l.args.tokensIn) / 1e18;
    if (tokens <= 0) continue;
    newTrades.push({ tx: l.transactionHash, logIndex: l.logIndex, block: Number(l.blockNumber), t: tsCache.get(l.blockNumber.toString()), wallet: (isBuy ? l.args.recipient : l.args.seller).toLowerCase(), side: isBuy ? "buy" : "sell", venue: "curve", quote, tokens, price: quote / tokens });
  }
  let lastSwap = null;
  for (const l of swapLogs) {
    const a0 = l.args.amount0, a1 = l.args.amount1;
    // v4 Swap amounts are the swapper's deltas: positive = received, negative = paid
    const tokenDelta = launch.tokenIsCurrency0 ? a0 : a1;
    const quoteDelta = launch.tokenIsCurrency0 ? a1 : a0;
    const isBuy = tokenDelta > 0n; // the swapper received tokens
    const tokens = Number(tokenDelta < 0n ? -tokenDelta : tokenDelta) / 1e18;
    const quote = Number(quoteDelta < 0n ? -quoteDelta : quoteDelta) / dq;
    if (tokens <= 0 || quote <= 0) continue;
    let wallet = attributeSwap(byTx.get(l.transactionHash) || [], isBuy);
    if (!wallet) {
      // could not find the person behind the router — keep the trade for the
      // price line but make sure the router never counts as a holder
      wallet = l.args.sender.toLowerCase();
      if (!system.has(wallet)) { system.add(wallet); routers.add(wallet); await setMeta("routers", [...routers].join(",")); }
    }
    newTrades.push({ tx: l.transactionHash, logIndex: l.logIndex, block: Number(l.blockNumber), t: tsCache.get(l.blockNumber.toString()), wallet, side: isBuy ? "buy" : "sell", venue: "pool", quote, tokens, price: quote / tokens });
    lastSwap = l;
  }
  newTrades.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  newTransfers.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);

  if (newTrades.length) {
    await sql`insert into trades ${sql(newTrades.map((x) => ({ tx: x.tx, log_index: x.logIndex, block: x.block, ts: x.t, wallet: x.wallet, side: x.side, venue: x.venue, quote: x.quote, tokens: x.tokens, price: x.price })))} on conflict do nothing`;
    ledger.trades.push(...newTrades);
    ledger.lastTradeAt = Math.max(ledger.lastTradeAt, newTrades[newTrades.length - 1].t);
  }
  if (newTransfers.length) {
    for (let i = 0; i < newTransfers.length; i += 500) {
      const chunk = newTransfers.slice(i, i + 500);
      await sql`insert into transfers ${sql(chunk.map((x) => ({ tx: x.tx, log_index: x.logIndex, block: x.block, ts: x.t, from: x.from, to: x.to, value: x.value })))} on conflict do nothing`;
    }
    ledger.transfers.push(...newTransfers);
  }
  if (lastSwap) {
    ledger.price = priceFromSqrt(lastSwap.args.sqrtPriceX96, launch);
    ledger.priceUpdatedAt = tsCache.get(lastSwap.blockNumber.toString());
    await setMeta("price", ledger.price); await setMeta("price_at", ledger.priceUpdatedAt);
  }
  ledger.version++;
  if (ledger.syncing && (newTrades.length || newTransfers.length)) console.log(`[indexer] ${from}-${to}: +${newTrades.length} trades +${newTransfers.length} transfers (block ${to})`);
}

/// Who traded in a v4 swap. The Swap's sender is a router, so read the token
/// transfers in the same tx: a buy delivers tokens from the PoolManager to a
/// non-protocol address; a sell starts with the user handing tokens to a router.
function attributeSwap(transfers, isBuy) {
  // net token flow per address inside the tx: routers net to zero, the user is
  // the biggest net receiver (buy) or net sender (sell) that is not protocol
  const net = new Map();
  for (const x of transfers) {
    net.set(x.to, (net.get(x.to) || 0) + x.value);
    net.set(x.from, (net.get(x.from) || 0) - x.value);
  }
  let best = null, bestV = 0;
  for (const [addr, v] of net) {
    if (system.has(addr)) continue;
    const s = isBuy ? v : -v;
    if (s > bestV + 1e-12) { bestV = s; best = addr; }
  }
  return best;
}

async function refreshSpot() {
  if (launch.phase === 0) {
    const p = await curveSpot(launch).catch(() => null);
    if (p) { ledger.price = p; ledger.priceUpdatedAt = Math.floor(Date.now() / 1000); }
  } else if (ledger.price === null) {
    // fresh boot after graduation with no swap seen yet — last stored pool trade
    const last = ledger.trades.filter((x) => x.venue === "pool").pop();
    if (last) { ledger.price = last.price; ledger.priceUpdatedAt = last.t; }
  }
}
