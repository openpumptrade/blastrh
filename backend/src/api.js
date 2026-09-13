import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { config, mode } from "./config.js";
import { sql } from "./db.js";
import { ledger, systemSet } from "./indexer.js";
import { coin, pot, engineWallet } from "./tracker.js";
import { state, rowToJson } from "./blaster.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const now = () => Math.floor(Date.now() / 1000);

export function startApi(launch) {
  const app = express();
  app.use(cors());
  app.set("etag", false);
  app.use("/api", (_req, res, next) => { res.set("cache-control", "no-store"); next(); });

  app.get("/api/health", (_req, res) => res.json({ ok: true, mode: mode(), scheduler: config.schedulerEnabled, started: !!launch, coin: launch?.symbol || "", phase: launch?.phase ?? null, syncing: ledger.syncing, lastBlock: ledger.lastBlock, trades: ledger.trades.length, nextBlastAt: state.nextBlastAt }));

  app.get("/api/token", (_req, res) => {
    if (!launch) return res.json({ started: false, brand: config.brand, rules: config.rules });
    const price = ledger.price;
    const usd = coin.usdPerQuote;
    res.json({
      started: true, mode: mode(), brand: config.brand, rules: config.rules,
      dryRun: config.dryRun || mode() !== "bot", schedulerEnabled: config.schedulerEnabled,
      chain: "Robinhood Chain", launchpad: "pons",
      token: launch.token, name: launch.name, symbol: launch.symbol, curve: launch.curve, poolId: launch.poolId,
      creator: launch.creatorFeeRecipient, wallet: engineWallet(), canBurn: launch.canBurn,
      quoteSymbol: launch.quoteSymbol, quoteDecimals: launch.quoteDecimals,
      phase: launch.phase, graduated: launch.phase === 2, curveProgress: coin.progress,
      priceQuote: price, priceUsd: price !== null && usd ? price * usd : null,
      mcapUsd: price !== null && usd ? price * coin.supply0 * usd : null,          // headline mcap on the original supply (what pons shows)
      realMcapUsd: price !== null && usd ? price * coin.supply * usd : null,       // after burns
      ethUsd: usd, usdPerQuote: usd,
      supply: coin.supply, supply0: coin.supply0, burned: coin.burned, deadTokens: coin.deadTokens,
      burnedPct: coin.supply0 ? coin.burned / coin.supply0 : 0, marketUpdatedAt: Math.max(coin.updatedAt, ledger.priceUpdatedAt || 0),
      pot: { escrowEth: pot.escrowEth, unsweptEth: pot.unsweptEth, walletEth: pot.walletEth, spendableEth: pot.spendableEth, walletTokens: pot.walletTokens, estTokens: pot.estTokens, updatedAt: pot.updatedAt, error: pot.error },
      nextBlastAt: state.nextBlastAt, genesis: state.genesis, progress: state.progress, lastNote: state.lastNote,
      blastsRun: state.blastsRun, totalSpentEth: state.totalSpentEth, totalBurned: state.totalBurned, dryTotals: state.dryTotals, lastBlast: state.lastBlast,
      syncing: ledger.syncing, lastBlock: ledger.lastBlock, lastTradeAt: ledger.lastTradeAt, excluded: [...systemSet()],
      links: {
        pons: `${config.ponsSiteUrl}/launchpad/${launch.token}`,
        explorer: `${config.explorer}/token/${launch.token}`,
        wallet: `${config.explorer}/address/${engineWallet()}`,
        tx: `${config.explorer}/tx/`,
      },
      now: now(),
    });
  });

  app.get("/api/blasts", async (req, res) => {
    const limit = Math.min(200, Number(req.query.limit || 60));
    const rows = await sql`select * from blasts where status in ('done', 'skipped', 'failed') order by id desc limit ${limit}`;
    res.json(rows.map(rowToJson));
  });

  /// price history for the chart: every on-chain trade (curve + pool) in USD, plus blast markers
  app.get("/api/chart", async (req, res) => {
    if (!launch) return res.status(404).json({ error: "not started" });
    const usd = coin.usdPerQuote || 0;
    const since = Number(req.query.since || 0);
    const src = since ? ledger.trades.filter((x) => x.t > since) : ledger.trades;
    const points = src.map((x) => ({ t: x.t, c: x.price * usd, s: x.side, q: x.quote, w: x.wallet }));
    const blasts = (await sql`select id, ts, dry, spent_eth, tokens_burned from blasts where status = 'done' order by id`).map((b) => ({ id: b.id, t: b.ts, dry: b.dry, spentEth: b.spent_eth, tokens: b.tokens_burned }));
    res.json({ source: "chain", points, blasts, priceUsd: ledger.price !== null ? ledger.price * usd : null, priceQuote: ledger.price, usdPerQuote: usd, supply0: coin.supply0, supply: coin.supply, syncing: ledger.syncing, now: now() });
  });

  app.get("/api/trades", (_req, res) => {
    if (!launch) return res.json([]);
    const usd = coin.usdPerQuote || 0;
    const sys = systemSet();
    const rows = ledger.trades.slice(-60).reverse().filter((x) => !sys.has(x.wallet) || x.wallet === engineWallet());
    res.json(rows.slice(0, 40).map((x) => ({ t: x.t, side: x.side, eth: x.quote, tokens: x.tokens, usd: x.quote * usd, priceUsd: x.price * usd, wallet: x.wallet, tx: x.tx, venue: x.venue, engine: x.wallet === engineWallet() })));
  });

  app.use(express.static(path.join(here, "..", "public"), { etag: false, maxAge: 0 }));
  app.listen(config.port, () => console.log(`[api] listening on :${config.port}`));
}
