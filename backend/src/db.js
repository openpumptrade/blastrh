import postgres from "postgres";
import { config } from "./config.js";

export const sql = postgres(config.databaseUrl, {
  max: 6,
  idle_timeout: 30,
  ssl: config.databaseUrl.includes("localhost") || config.databaseUrl.includes("127.0.0.1") ? false : "require",
  transform: { undefined: null },
  onnotice: () => {},
});

/// Idempotent schema — runs at boot (Railway has no shell for migrations).
export async function ensureSchema() {
  await sql`create table if not exists meta (key text primary key, value text not null)`;
  // on-chain ledger (indexer.js): every trade + every token transfer
  await sql`create table if not exists trades (
    tx text not null, log_index int not null, block bigint not null, ts int not null,
    wallet text not null, side text not null, venue text not null,
    quote double precision not null, tokens double precision not null, price double precision not null,
    primary key (tx, log_index))`;
  await sql`create index if not exists trades_wallet on trades (wallet)`;
  await sql`create index if not exists trades_block on trades (block, log_index)`;
  await sql`create table if not exists transfers (
    tx text not null, log_index int not null, block bigint not null, ts int not null,
    "from" text not null, "to" text not null, value double precision not null,
    primary key (tx, log_index))`;
  await sql`create index if not exists transfers_block on transfers (block, log_index)`;
  // the blasts (blaster.js): claim → buy → burn, one row each
  await sql`create table if not exists blasts (
    id serial primary key, ts int not null,
    status text not null default 'claiming',
    dry boolean not null default false,
    pot_eth double precision not null default 0,
    claimed_eth double precision not null default 0,
    spent_eth double precision not null default 0,
    tokens_burned double precision not null default 0,
    price_usd double precision, eth_usd double precision, supply_after double precision,
    venue text, claim_tx text, buy_tx text, burn_tx text,
    note text, finished_at int)`;
  await sql`create index if not exists blasts_ts on blasts (ts)`;
}

export async function getMeta(key, fallback = null) {
  const rows = await sql`select value from meta where key = ${key}`;
  return rows.length ? rows[0].value : fallback;
}
export async function setMeta(key, value) {
  await sql`insert into meta (key, value) values (${key}, ${String(value)})
    on conflict (key) do update set value = excluded.value`;
}
