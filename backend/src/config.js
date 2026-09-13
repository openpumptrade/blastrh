import "dotenv/config";

/// BLAST engine config — Robinhood Chain edition. One engine per pons v2
/// launch: every BLAST_INTERVAL_SEC it claims 100% of the creator rewards,
/// market-buys the coin with all of it in ONE tx and burns what it bought.
/// Supply only goes down. Everything is an env var so the same image can run
/// any launch.

const lower = (s) => (s || "").trim().toLowerCase();
const list = (s) => (s || "").split(",").map((x) => lower(x)).filter(Boolean);
const num = (v, d) => (v === undefined || v === "" ? d : Number(v));
const bool = (v, d) => (v === undefined || v === "" ? d : String(v).toLowerCase() === "true");

// only a real 32-byte hex key counts; a placeholder such as PASTE_PRIVATE_KEY_HERE keeps watch mode
const rawKey = (process.env.WALLET_PRIVATE_KEY || process.env.REWARD_WALLET_PK || "").trim();
const walletPk = /^(0x)?[0-9a-fA-F]{64}$/.test(rawKey) ? rawKey.replace(/^(?!0x)/, "0x") : "";

export const config = {
  port: Number(process.env.PORT || 4000),
  databaseUrl: process.env.DATABASE_URL || "postgres://localhost:5432/blastrh",

  // Robinhood Chain (chain id 4663). Official RPC sits behind Cloudflare and
  // 403s datacenter IPs — ranked fallback list, same as the DCA engine.
  rpcUrls: (process.env.RPC_URLS ||
    [
      process.env.RPC_URL,
      "https://robinhood-rpc.publicnode.com",
      "https://robinhood.api.pocket.network",
      "https://rpc.mainnet.chain.robinhood.com",
    ]
      .filter(Boolean)
      .join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  chainId: num(process.env.CHAIN_ID, 4663),

  // brand — the page reads these from /api/token
  brand: {
    name: process.env.BRAND_NAME || "BLAST",
    siteUrl: (process.env.SITE_URL || "http://localhost:4000").replace(/\/$/, ""),
    twitter: process.env.BRAND_TWITTER || "",
    telegram: process.env.BRAND_TELEGRAM || "",
  },

  // the launch — one engine per coin
  token: lower(process.env.TOKEN_ADDRESS),
  // ETH-quoted launches only by default (a custom pair such as GLD is refused at boot)
  requireNative: bool(process.env.REQUIRE_NATIVE, true),
  launchBlock: process.env.LAUNCH_BLOCK ? Number(process.env.LAUNCH_BLOCK) : 0,

  // pons v2 on Robinhood Chain (docs.ponsfamily.com/docs/v2 → Deployed addresses)
  ponsFactory: process.env.PONS_FACTORY || "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",
  ponsFeeEscrow: process.env.PONS_FEE_ESCROW || "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e",
  ponsHook: process.env.PONS_HOOK || "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044",
  // Uniswap v4 on Robinhood Chain (docs.uniswap.org/contracts/v4/deployments → 4663)
  poolManager: process.env.POOL_MANAGER || "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  universalRouter: process.env.UNIVERSAL_ROUTER || "0x8876789976decbfcbbbe364623c63652db8c0904",
  v4Quoter: process.env.V4_QUOTER || "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
  // protocol addresses that must never count as holders / traders
  ponsSystem: [
    "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e", // factory
    "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044", // meme hook
    "0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e", // fee escrow
    "0x42df2a798f82289e177311362e8f5ccc45c1219c", // buyback vault
    "0x267444d099b10fb5ed7c3cc7b7c767adca574952", // launch locker
    "0xe33e9e479df8802cb0866d5d05258bec4cf62948", // launch and buy
    "0x3711cea4feade896c913c68f01eda97cb06d1a42", // launch deployer
    "0xc7819b64a1daecd7ec19856d026cb14efbd89046", // graduation executor
    "0xf5695117b99b6f6401e67d4195bd653628176c6c", // graduation guard
    "0x8366a39cc670b4001a1121b8f6a443a643e40951", // v4 pool manager
    "0x8876789976decbfcbbbe364623c63652db8c0904", // v4 universal router
    "0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb", // pons v1 factory
    "0x0c37a24f5d23a486fa692d1500881d698b1f77a4", // v4 router
    "0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc", // aggregator router
    "0xccc88a9d1b4ed6b0eaba998850414b24f1c315be", // relay approval proxy
    "0x000000000000000000000000000000000000dead",
    "0x0000000000000000000000000000000000000000",
  ],
  excludedExtra: list(process.env.EXCLUDED_WALLETS),

  // the engine wallet = the launch's creatorFeeRecipient. With its key the
  // engine claims + buys + burns ("bot" mode); without it the engine only
  // watches the pot and records dry blasts ("watch" mode).
  walletPk,
  walletAddress: lower(process.env.WALLET_ADDRESS || process.env.REWARD_WALLET), // optional in watch mode: address to read the pot from
  dryRun: bool(process.env.DRY_RUN, false),
  // master kill switch — API and page stay up, nothing moves
  schedulerEnabled: bool(process.env.SCHEDULER_ENABLED, true),

  rules: {
    intervalSec: num(process.env.BLAST_INTERVAL_SEC, 180),    // one blast every 3 minutes
    minClaimEth: num(process.env.MIN_CLAIM_ETH, 0.0002),      // don't bother claiming dust
    minBuyEth: num(process.env.MIN_BUY_ETH, 0.0005),          // a blast smaller than this rolls into the next one
    gasReserveEth: num(process.env.GAS_RESERVE_ETH, 0.002),   // ETH kept in the wallet for tx fees, never spent on buys
    slippagePct: num(process.env.SLIPPAGE_PCT, 5),
  },
  pollSec: num(process.env.POLL_SEC, 10),
  indexMs: num(process.env.INDEX_MS, 3000),
  // manual override for the quote asset's USD price (else DeFiLlama / pons)
  quoteUsdOverride: num(process.env.QUOTE_USD, 0),
  ponsSiteUrl: process.env.PONS_SITE_URL || "https://www.ponsfamily.com",
  explorer: process.env.EXPLORER_URL || "https://robinhoodchain.blockscout.com",
};

export const mode = () => (config.walletPk ? "bot" : "watch");

if (!config.token) console.warn("[config] TOKEN_ADDRESS not set — the page runs in 'not started' mode");
if (!config.walletPk) console.warn(`[config] WALLET_PRIVATE_KEY ${rawKey ? "is not a valid private key" : "not set"} — watch mode: dry blasts, nothing moves`);
if (!config.schedulerEnabled) console.warn("[config] SCHEDULER_ENABLED=false — kill switch ON: no claims, no buys, no burns");
