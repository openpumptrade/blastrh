# BLAST — every 3 minutes, one buy, burned. (Robinhood Chain)

Buyback-and-burn engine for a **pons v2** launch on Robinhood Chain. Every `BLAST_INTERVAL_SEC` (3 minutes), on a fixed clock, the engine:

1. claims **100%** of the creator rewards — sweeps the curve fees it is allowed to sweep and claims the pons fee escrow into the engine wallet,
2. makes **one** market buy of the coin with everything in the wallet (minus `GAS_RESERVE_ETH`) — on the bonding curve, or through the Uniswap v4 Universal Router once graduated,
3. **burns** every token the wallet holds with the token's own `burn()` (falls back to 0xdead if a token lacks it) — total supply goes down on Blockscout.

No ops cut, no team share. A pot under `MIN_BUY_ETH` rolls into the next blast; a failed buy or burn is retried next blast (the ETH / tokens are still in the wallet).

## Run

```bash
cd backend && cp .env.example .env   # fill TOKEN_ADDRESS (+ WALLET_PRIVATE_KEY of the creator fee recipient for real blasts)
createdb blastrh
npm install && npm run dev            # http://localhost:4000
```

Without a valid `WALLET_PRIVATE_KEY` the engine runs in **watch mode**: it indexes the chain, tracks the pot and records dry blasts. `SCHEDULER_ENABLED=false` is the kill switch (API + page stay up, nothing moves).

## Pieces

- `src/indexer.js` — eth_getLogs indexer: CurveBuy/CurveSell on the curve, Swap on the Uniswap v4 PoolManager (by poolId) after graduation, token Transfers. Feeds the chart, the ticker and the live price.
- `src/tracker.js` — total supply (shrinks with every burn), curve progress, ETH/USD, the pot (escrow + unswept + wallet), estimated tokens for the next blast.
- `src/blaster.js` — fixed-clock scheduler, the claim → buy → burn pipeline with live progress, per-blast rows (claim/buy/burn tx hashes).
- `src/pons.js` — pons v2 ABIs, escrow claim, curve quote + buy, Universal Router V4_SWAP buy (+ V4Quoter floor), burn.
- `src/api.js` — `/api/token`, `/api/chart`, `/api/trades`, `/api/blasts`, `/api/health` + the page in `public/`.

## Hosting

- **Railway**: root `Dockerfile` runs the engine (API + page) with a Postgres plugin.
- **Vercel**: `backend/public` as a static site; its `vercel.json` proxies `/api/*` to the Railway service (replace `RAILWAY_ENGINE_URL`).
