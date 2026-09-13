import { encodeAbiParameters, encodePacked, keccak256, parseAbi, zeroAddress } from "viem";
import { config } from "./config.js";
import { client, walletClient } from "./evm.js";

/// pons v2 protocol surface used by the engine (docs.ponsfamily.com/docs/v2)
/// plus the Uniswap v4 Universal Router for buys after graduation. Native
/// quote (ETH) and custom-pair (ERC-20) launches both work: the quote asset is
/// read from the launch record, never assumed.

export const FACTORY_ABI = parseAbi([
  "function getLaunchedToken(address token) view returns ((address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists))",
]);

export const CURVE_ABI = parseAbi([
  "function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)",
  "function sellableTokens() view returns (uint256)",
  "function feeBps() view returns (uint256)",
  "function creatorTaxBps() view returns (uint256)",
  "function currentSnipeTaxBps(address recipient) view returns (uint256)",
  "function quoteFeeBalance() view returns (uint256)",
  "function creatorTaxBalance() view returns (uint256)",
  "function realQuoteReserve() view returns (uint256)",
  "function graduationThreshold() view returns (uint256)",
  "function graduated() view returns (bool)",
  "function readyToGraduate() view returns (bool)",
  "function sweepFees(uint256 minBuybackTokensOut)",
  "function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)",
  "event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)",
  "event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)",
]);

export const HOOK_ABI = parseAbi([
  "function pendingFees(bytes32 poolId, address currency) view returns (uint256)",
  "function pendingCreatorTax(bytes32 poolId, address currency) view returns (uint256)",
  "function sweepPoolFees(bytes32 poolId, uint256 minConversionQuoteOut, uint256 minBuybackTokensOut)",
  "function feeSweepOperator() view returns (address)",
]);

export const ESCROW_ABI = parseAbi([
  "function balanceOf(address recipient) view returns (uint256)",
  "function balanceOfToken(address recipient, address token) view returns (uint256)",
  "function claim()",
  "function claimToken(address token)",
]);

export const ERC20_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function burn(uint256 amount)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export const POOL_MANAGER_ABI = parseAbi([
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
]);

// Uniswap v4 periphery (Universal Router + V4Quoter)
const UNIVERSAL_ROUTER_ABI = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);
const POOL_KEY = [
  { name: "currency0", type: "address" }, { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" },
];
const V4_QUOTER_ABI = [{
  type: "function", name: "quoteExactInputSingle", stateMutability: "nonpayable",
  inputs: [{ name: "params", type: "tuple", components: [
    { name: "poolKey", type: "tuple", components: POOL_KEY },
    { name: "zeroForOne", type: "bool" }, { name: "exactAmount", type: "uint128" }, { name: "hookData", type: "bytes" },
  ] }],
  outputs: [{ name: "amountOut", type: "uint256" }, { name: "gasEstimate", type: "uint256" }],
}];
const V4_SWAP = "0x10";                 // Universal Router command
const SWAP_EXACT_IN_SINGLE = 0x06, SETTLE_ALL = 0x0c, TAKE_ALL = 0x0f; // v4 router actions
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const PERMIT2_ABI = parseAbi(["function approve(address token, address spender, uint160 amount, uint48 expiration)"]);
const DEAD = "0x000000000000000000000000000000000000dEaD";
const BPS = 10_000n;

/// Resolve everything about the launch from the factory: curve, quote asset,
/// creator payout wallet, phase (0 curve · 1 swept · 2 pool) and the v4 poolKey/poolId.
export async function loadLaunch(token) {
  const rec = await client.readContract({ address: config.ponsFactory, abi: FACTORY_ABI, functionName: "getLaunchedToken", args: [token] });
  if (!rec.exists) throw new Error(`${token} was not launched by the pons v2 factory ${config.ponsFactory}`);
  const native = rec.pairToken.toLowerCase() === zeroAddress;
  let quoteSymbol = "ETH", quoteDecimals = 18;
  if (!native) {
    [quoteSymbol, quoteDecimals] = await Promise.all([
      client.readContract({ address: rec.pairToken, abi: ERC20_ABI, functionName: "symbol" }).catch(() => "QUOTE"),
      client.readContract({ address: rec.pairToken, abi: ERC20_ABI, functionName: "decimals" }).catch(() => 18),
    ]);
  }
  const [tokenName, tokenSymbol, totalSupply, code] = await Promise.all([
    client.readContract({ address: token, abi: ERC20_ABI, functionName: "name" }).catch(() => "TOKEN"),
    client.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" }).catch(() => "TOKEN"),
    client.readContract({ address: token, abi: ERC20_ABI, functionName: "totalSupply" }).catch(() => 10n ** 27n),
    client.getBytecode({ address: token }).catch(() => "0x"),
  ]);
  // Uniswap v4 sorts currencies by address; native ETH (zero) is always currency0
  const pair = rec.pairToken.toLowerCase(), tok = token.toLowerCase();
  const tokenIsCurrency0 = tok < pair;
  const [currency0, currency1] = tokenIsCurrency0 ? [token, rec.pairToken] : [rec.pairToken, token];
  const poolKey = { currency0, currency1, fee: rec.poolFee, tickSpacing: rec.tickSpacing, hooks: config.ponsHook };
  const poolId = keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [currency0, currency1, rec.poolFee, rec.tickSpacing, config.ponsHook],
  ));
  return {
    token: tok,
    name: tokenName,
    symbol: tokenSymbol,
    curve: rec.curve.toLowerCase(),
    deployer: rec.deployer.toLowerCase(),
    creatorFeeRecipient: rec.creatorFeeRecipient.toLowerCase(),
    pairToken: pair,
    native,
    quoteSymbol,
    quoteDecimals: Number(quoteDecimals),
    creatorTaxBps: Number(rec.creatorTaxBps),
    phase: Number(rec.phase),
    poolKey,
    poolId,
    tokenIsCurrency0,
    totalSupply: Number(totalSupply) / 1e18,
    graduationThreshold: rec.graduationThreshold,
    // ERC20Burnable: burn(uint256) really lowers totalSupply. Without it we send to 0xdead.
    canBurn: String(code || "").includes("42966c68"),
  };
}

export async function refreshPhase(launch) {
  const rec = await client.readContract({ address: config.ponsFactory, abi: FACTORY_ABI, functionName: "getLaunchedToken", args: [launch.token] });
  launch.phase = Number(rec.phase);
  launch.creatorFeeRecipient = rec.creatorFeeRecipient.toLowerCase();
  return launch;
}

export async function readTotalSupply(launch) {
  const raw = await client.readContract({ address: launch.token, abi: ERC20_ABI, functionName: "totalSupply" });
  return Number(raw) / 1e18;
}

export async function deadBalance(launch) {
  const raw = await client.readContract({ address: launch.token, abi: ERC20_ABI, functionName: "balanceOf", args: [DEAD] }).catch(() => 0n);
  return Number(raw) / 1e18;
}

export async function tokenBalanceRaw(launch, wallet) {
  return client.readContract({ address: launch.token, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet] });
}

/// Spot price in quote per token from the curve reserves (pre-graduation).
export async function curveSpot(launch) {
  const [quoteReserve, tokenReserve] = await client.readContract({ address: launch.curve, abi: CURVE_ABI, functionName: "getReserves" });
  if (tokenReserve === 0n) return null;
  const q = Number(quoteReserve) / 10 ** launch.quoteDecimals;
  const t = Number(tokenReserve) / 1e18;
  return q / t;
}

/// Price (quote per token) from a v4 Swap's sqrtPriceX96.
export function priceFromSqrt(sqrtPriceX96, launch) {
  const r = Number(sqrtPriceX96) / 2 ** 96; // sqrt(currency1 per currency0)
  const c1PerC0 = r * r;
  const dq = 10 ** launch.quoteDecimals, dt = 1e18;
  if (launch.tokenIsCurrency0) return c1PerC0 * (dt / dq); // quote per token
  return (1 / c1PerC0) * (dt / dq);
}

/// Curve progress: real quote collected vs the graduation threshold.
export async function curveProgress(launch) {
  try {
    const [real, threshold] = await Promise.all([
      client.readContract({ address: launch.curve, abi: CURVE_ABI, functionName: "realQuoteReserve" }),
      client.readContract({ address: launch.curve, abi: CURVE_ABI, functionName: "graduationThreshold" }),
    ]);
    return threshold > 0n ? Number(real) / Number(threshold) : 0;
  } catch { return 0; }
}

// ------------------------------------------------------------ fee plumbing

/// Fees accrued but not yet swept (curve before graduation, hook after), in quote units.
export async function unsweptQuote(launch) {
  try {
    if (launch.phase === 0) {
      const [a, b] = await Promise.all([
        client.readContract({ address: launch.curve, abi: CURVE_ABI, functionName: "quoteFeeBalance" }),
        client.readContract({ address: launch.curve, abi: CURVE_ABI, functionName: "creatorTaxBalance" }),
      ]);
      return Number(a + b) / 10 ** launch.quoteDecimals;
    }
    const cur = launch.native ? zeroAddress : launch.pairToken;
    const [a, b] = await Promise.all([
      client.readContract({ address: config.ponsHook, abi: HOOK_ABI, functionName: "pendingFees", args: [launch.poolId, cur] }),
      client.readContract({ address: config.ponsHook, abi: HOOK_ABI, functionName: "pendingCreatorTax", args: [launch.poolId, cur] }),
    ]);
    return Number(a + b) / 10 ** launch.quoteDecimals;
  } catch {
    return 0;
  }
}

/// What the escrow already credited the wallet, in quote units.
export async function escrowQuote(launch, wallet) {
  const raw = launch.native
    ? await client.readContract({ address: config.ponsFeeEscrow, abi: ESCROW_ABI, functionName: "balanceOf", args: [wallet] })
    : await client.readContract({ address: config.ponsFeeEscrow, abi: ESCROW_ABI, functionName: "balanceOfToken", args: [wallet, launch.pairToken] });
  return Number(raw) / 10 ** launch.quoteDecimals;
}

/// Quote balance sitting in a wallet, in quote units.
export async function quoteBalance(launch, wallet) {
  const raw = launch.native
    ? await client.getBalance({ address: wallet })
    : await client.readContract({ address: launch.pairToken, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet] });
  return Number(raw) / 10 ** launch.quoteDecimals;
}

/// Sweep pending fees (the creator may call when no internal swap is needed)
/// and claim the escrow into the engine wallet. Returns tx hashes + claimed amount.
let sweepOperator = null;
export async function sweepAndClaim(launch) {
  if (!walletClient) throw new Error("no wallet key");
  const me = walletClient.account.address;
  const txs = [];
  try {
    if (launch.phase === 0) {
      const pending = await client.readContract({ address: launch.curve, abi: CURVE_ABI, functionName: "quoteFeeBalance" });
      if (pending > 0n) {
        const hash = await walletClient.writeContract({ address: launch.curve, abi: CURVE_ABI, functionName: "sweepFees", args: [0n] });
        await client.waitForTransactionReceipt({ hash });
        txs.push(hash);
      }
    } else {
      // after graduation only pons' fee-sweep operator can run sweepPoolFees
      // (it converts token fees → quote); it lands in the escrow and we claim it
      if (sweepOperator === null) sweepOperator = String(await client.readContract({ address: config.ponsHook, abi: HOOK_ABI, functionName: "feeSweepOperator" })).toLowerCase();
      const cur = launch.native ? zeroAddress : launch.pairToken;
      const pending = sweepOperator === me.toLowerCase() ? await client.readContract({ address: config.ponsHook, abi: HOOK_ABI, functionName: "pendingFees", args: [launch.poolId, cur] }) : 0n;
      if (pending > 0n) {
        const hash = await walletClient.writeContract({ address: config.ponsHook, abi: HOOK_ABI, functionName: "sweepPoolFees", args: [launch.poolId, 0n, 0n] });
        await client.waitForTransactionReceipt({ hash });
        txs.push(hash);
      }
    }
  } catch (err) {
    // InternalSwapRequiresOperator etc. — pons' own operator sweeps those
    console.warn(`[claim] sweep skipped: ${String(err.shortMessage || err.message).slice(0, 140)}`);
  }
  const owed = await escrowQuote(launch, me);
  if (owed > 0) {
    const hash = launch.native
      ? await walletClient.writeContract({ address: config.ponsFeeEscrow, abi: ESCROW_ABI, functionName: "claim" })
      : await walletClient.writeContract({ address: config.ponsFeeEscrow, abi: ESCROW_ABI, functionName: "claimToken", args: [launch.pairToken] });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`escrow claim reverted (${hash})`);
    txs.push(hash);
  }
  return { claimed: owed, txs };
}

// ------------------------------------------------------------------ quotes

const amountOut = (inAmount, reserveIn, reserveOut) => (inAmount * reserveOut) / (reserveIn + inAmount);
const amountIn = (outAmount, reserveIn, reserveOut) => (outAmount * reserveIn) / (reserveOut - outAmount) + 1n;
const ceilDiv = (a, b) => (a + b - 1n) / b;

/// Tokens out for a curve buy — the curve's own arithmetic in the same integer
/// order (docs → Getting a quote). Fees come off the input; clamp to sellable.
export async function quoteCurveBuy(launch, quoteIn, recipient) {
  const read = (functionName, args = []) => client.readContract({ address: launch.curve, abi: CURVE_ABI, functionName, args });
  const [reserves, sellable, feeBps, creatorTaxBps, rawSnipeBps] = await Promise.all([
    read("getReserves"), read("sellableTokens"), read("feeBps"), read("creatorTaxBps"), read("currentSnipeTaxBps", [recipient || zeroAddress]),
  ]);
  const [quoteReserve, tokenReserve] = reserves;
  let snipeBps = rawSnipeBps;
  if (snipeBps > 0n) {
    const maxSnipeBps = BPS - feeBps - creatorTaxBps - 100n;
    if (snipeBps > maxSnipeBps) snipeBps = maxSnipeBps;
  }
  let spent = quoteIn;
  const fee = (spent * feeBps) / BPS;
  const tax = (spent * creatorTaxBps) / BPS;
  const snipeTax = (spent * snipeBps) / BPS;
  let tokensOut = amountOut(spent - fee - tax - snipeTax, quoteReserve, tokenReserve);
  if (tokensOut > sellable) {
    tokensOut = sellable;
    const net = amountIn(sellable, quoteReserve, tokenReserve);
    const grossed = ceilDiv(net * BPS, BPS - feeBps - creatorTaxBps - snipeBps);
    spent = grossed < quoteIn ? grossed : quoteIn;
  }
  return { tokensOut, spent, refund: quoteIn - spent };
}

/// Tokens out for a pool buy, from the Uniswap V4Quoter (reverts internally, eth_call only).
export async function quotePoolBuy(launch, quoteIn) {
  const { result } = await client.simulateContract({
    address: config.v4Quoter, abi: V4_QUOTER_ABI, functionName: "quoteExactInputSingle",
    args: [{ poolKey: launch.poolKey, zeroForOne: !launch.tokenIsCurrency0, exactAmount: quoteIn, hookData: "0x" }],
  });
  return result[0];
}

/// Estimate for the page / dry blasts: tokens a buy of `quoteIn` would get now.
export async function quoteBuy(launch, quoteIn, recipient) {
  if (quoteIn <= 0n) return 0n;
  if (launch.phase === 0) return (await quoteCurveBuy(launch, quoteIn, recipient)).tokensOut;
  if (launch.phase === 2) return quotePoolBuy(launch, quoteIn);
  return 0n;
}

// -------------------------------------------------------------------- buys

const withSlippage = (x) => (x * BigInt(Math.round((100 - config.rules.slippagePct) * 100))) / 10_000n;

/// ONE buy on the bonding curve. Returns {hash, tokensOut} after 1 confirmation.
export async function curveBuy(launch, quoteIn) {
  if (!walletClient) throw new Error("no wallet key");
  const me = walletClient.account.address;
  const { tokensOut } = await quoteCurveBuy(launch, quoteIn, me);
  const minOut = withSlippage(tokensOut);
  if (!launch.native) await ensureAllowance(launch.pairToken, launch.curve, quoteIn);
  const hash = await walletClient.writeContract({
    address: launch.curve, abi: CURVE_ABI, functionName: "buy", args: [quoteIn, minOut, me], value: launch.native ? quoteIn : 0n,
  });
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`curve buy reverted (${hash})`);
  return { hash, expected: tokensOut };
}

/// ONE buy on the Uniswap v4 pool through the Universal Router:
/// V4_SWAP → [SWAP_EXACT_IN_SINGLE, SETTLE_ALL(quote), TAKE_ALL(token)].
/// Native quote rides along as msg.value; an ERC-20 quote goes through Permit2.
export async function poolBuy(launch, quoteIn) {
  if (!walletClient) throw new Error("no wallet key");
  let minOut = 0n;
  try { minOut = withSlippage(await quotePoolBuy(launch, quoteIn)); }
  catch (err) { console.warn(`[buy] quoter failed, buying without a floor: ${String(err.shortMessage || err.message).slice(0, 120)}`); }
  const quoteCurrency = launch.native ? zeroAddress : launch.pairToken;
  const actions = encodePacked(["uint8", "uint8", "uint8"], [SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL]);
  const swapParams = encodeAbiParameters(
    [{ type: "tuple", components: [
      { name: "poolKey", type: "tuple", components: POOL_KEY },
      { name: "zeroForOne", type: "bool" }, { name: "amountIn", type: "uint128" }, { name: "amountOutMinimum", type: "uint128" }, { name: "hookData", type: "bytes" },
    ] }],
    [{ poolKey: launch.poolKey, zeroForOne: !launch.tokenIsCurrency0, amountIn: quoteIn, amountOutMinimum: minOut, hookData: "0x" }],
  );
  const settle = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [quoteCurrency, quoteIn]);
  const take = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [launch.token, minOut]);
  const input = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, [swapParams, settle, take]]);
  if (!launch.native) await ensurePermit2(launch.pairToken, quoteIn);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 120);
  const hash = await walletClient.writeContract({
    address: config.universalRouter, abi: UNIVERSAL_ROUTER_ABI, functionName: "execute",
    args: [V4_SWAP, [input], deadline], value: launch.native ? quoteIn : 0n,
  });
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`pool buy reverted (${hash})`);
  return { hash, expected: minOut };
}

async function ensureAllowance(token, spender, amount) {
  const me = walletClient.account.address;
  const cur = await client.readContract({ address: token, abi: ERC20_ABI, functionName: "allowance", args: [me, spender] });
  if (cur >= amount) return;
  const hash = await walletClient.writeContract({ address: token, abi: ERC20_ABI, functionName: "approve", args: [spender, 2n ** 256n - 1n] });
  await client.waitForTransactionReceipt({ hash });
}

async function ensurePermit2(token, amount) {
  await ensureAllowance(token, PERMIT2, amount);
  const hash = await walletClient.writeContract({ address: PERMIT2, abi: PERMIT2_ABI, functionName: "approve", args: [token, config.universalRouter, 2n ** 160n - 1n, 2 ** 48 - 1] });
  await client.waitForTransactionReceipt({ hash });
}

// -------------------------------------------------------------------- burn

/// Burn every token the wallet holds. ERC20Burnable.burn lowers totalSupply;
/// a token without it gets sent to 0xdead instead. Returns {hash, amount}.
export async function burnAll(launch) {
  if (!walletClient) throw new Error("no wallet key");
  const me = walletClient.account.address;
  const amount = await tokenBalanceRaw(launch, me);
  if (amount === 0n) return { hash: null, amount: 0n };
  const hash = launch.canBurn
    ? await walletClient.writeContract({ address: launch.token, abi: ERC20_ABI, functionName: "burn", args: [amount] })
    : await walletClient.writeContract({ address: launch.token, abi: ERC20_ABI, functionName: "transfer", args: [DEAD, amount] });
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`burn reverted (${hash})`);
  return { hash, amount };
}
