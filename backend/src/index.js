import { config, mode } from "./config.js";
import { ensureSchema } from "./db.js";
import { loadLaunch } from "./pons.js";
import { loadCoin, startTracker } from "./tracker.js";
import { startIndexer } from "./indexer.js";
import { startBlaster } from "./blaster.js";
import { startApi } from "./api.js";

/// BLAST — every 3 minutes, 100% of the creator rewards → one buy → burned.
/// Robinhood Chain / pons v2. One process: on-chain indexer + tracker + blaster + API + page.

async function main() {
  await ensureSchema();
  if (!config.token) {
    startApi(null);
    console.log("[boot] no TOKEN_ADDRESS — serving the page in 'not started' mode");
    return;
  }
  const launch = await loadLaunch(config.token);
  if (config.requireNative && !launch.native) throw new Error(`${launch.symbol} is paired with ${launch.quoteSymbol} (${launch.pairToken}) — BLAST runs on ETH-quoted launches only (REQUIRE_NATIVE=false to override)`);
  console.log(`[boot] ${launch.name} (${launch.symbol}) · quote ${launch.quoteSymbol}${launch.native ? " (native)" : " " + launch.pairToken} · phase ${launch.phase} · curve ${launch.curve} · creator ${launch.creatorFeeRecipient}`);
  console.log(`[boot] mode ${mode()} · dryRun ${config.dryRun} · scheduler ${config.schedulerEnabled} · burn via ${launch.canBurn ? "burn()" : "0xdead"}`);
  await loadCoin(launch);
  startApi(launch);
  await startTracker();
  await startIndexer(launch);
  await startBlaster(launch);
}

main().catch((err) => { console.error("[boot] fatal:", err); process.exit(1); });
