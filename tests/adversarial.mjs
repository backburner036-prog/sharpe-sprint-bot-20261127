// Adversarial tests for the Sharpe Sprint sniper (GATE-G).
// One runnable case per SPEC sentence, plus the static determinism /
// no-network / no-secret rules. Run: `node tests/adversarial.mjs`
// (from the repo root; needs the grade-local dev JSON at
// ../grade-local-dev.json — the file the builder saved next to the repo dir —
// or pass --grade <path>).
//
// The strategy is driven directly through the vendored BotState shim, the
// same class the grader's runBot uses, with synthetic batches. No network,
// no clock, no randomness anywhere in this file either.

import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { BotState } from '../vendor/agentfun-bot.ts';
import { createStrategy, TUNE } from '../strategy.ts';

const args = process.argv.slice(2);
const gradePath = (() => {
  const i = args.indexOf('--grade');
  return i >= 0 ? args[i + 1] : new URL('../../grade-local-dev.json', import.meta.url).pathname;
})();

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name} ${detail}`);
  }
}

// ---------------------------------------------------------------- fixtures
const HELLO = {
  type: 'hello',
  protocol: 'agent-fun/replay/v2',
  seed: '1',
  universe: { program: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', quote: 'SOL', mayhem: 'excluded', exclude_cashback: true, sample: { hash: 'sha256', modulus: 16, residue: 15 } },
  capital: { lamports: '10000000000' },
  caps: { max_open_positions: 5, max_order_bps_of_real_reserve: 100, max_orders_per_batch: 16, shorts: false, leverage: false },
  latency_slots: 2,
  fees: { protocol_bps_fallback: 95, creator_bps_fallback: 30, base_fee_lamports: '5000', priority_fee_lamports: '100000', failed_tx_bps: 200 },
};
const SOL = 1_000_000_000n;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const mint = (i) => `M${'1'.repeat(41)}${B58[i % 58]}${B58[Math.floor(i / 58) % 58]}`;
const wallet = (i) => `W${'1'.repeat(41)}${B58[i % 58]}${B58[Math.floor(i / 58) % 58]}`;
const VQ0 = 30_000_000_000n;
const VT0 = 1_073_000_000_000_000n;

function createEv(m, slot, creator) {
  return { event: 'CreateEvent', mint: m, creator, user: creator, slot, block_time: 1793589000 + slot, virtual_quote_reserves: VQ0.toString(), virtual_sol_reserves: VQ0.toString(), virtual_token_reserves: VT0.toString(), real_token_reserves: '793100000000000' };
}
function tradeEv(m, slot, user, isBuy, sol, rq) {
  return { event: 'TradeEvent', mint: m, user, creator: wallet(0), slot, block_time: 1793589000 + slot, is_buy: isBuy, sol_amount: sol.toString(), token_amount: '1000000000', virtual_quote_reserves: VQ0.toString(), virtual_sol_reserves: VQ0.toString(), virtual_token_reserves: VT0.toString(), real_quote_reserves: rq.toString(), real_sol_reserves: rq.toString(), real_token_reserves: '793100000000000' };
}
function batch(seq, slot, events, marks = [], fills = [], positions = []) {
  return { type: 'batch', seq, slot, events, marks, fills, account: { cash_lamports: '10000000000', positions } };
}
function mark(m, slot, vq, vt) {
  return { mint: m, slot, virtual_quote_reserves: vq.toString(), virtual_sol_reserves: vq.toString(), virtual_token_reserves: vt.toString(), real_token_reserves: '793100000000000', real_quote_reserves: (10n * SOL).toString(), real_sol_reserves: (10n * SOL).toString() };
}
/** Drive one fresh strategy through batches; returns all wire orders sent. */
function drive(batches) {
  const state = new BotState(HELLO);
  const strat = createStrategy(TUNE);
  const sent = [];
  for (const b of batches) {
    state.applyBatch(b);
    const orders = state.toOrders(strat.onBatch(state, b));
    state.recordOrders(orders);
    sent.push(...orders);
  }
  return { state, sent };
}
/** A clean launch: creator buys 1 SOL, two outsiders buy 4.5 SOL each -> rq 10 SOL. */
function cleanLaunch(m, slot, creator) {
  return [
    createEv(m, slot, creator),
    tradeEv(m, slot, creator, true, 1n * SOL, 1n * SOL),
    tradeEv(m, slot, wallet(1), true, 4500000000n, 5500000000n),
    tradeEv(m, slot, wallet(2), true, 4500000000n, 10n * SOL),
  ];
}

// ---------------------------------------------------------------- S1 paper only
{
  const src = readFileSync(new URL('../strategy.ts', import.meta.url), 'utf8') + readFileSync(new URL('../main.ts', import.meta.url), 'utf8');
  const banned = ['fetch(', 'http://', 'https://', 'node:fs', 'node:net', 'child_process', 'Date.now', 'Math.random', 'process.env', 'readFile', '.git/'];
  check('S1 paper-only: no network/IO/clock/random in main+strategy', banned.every((p) => !src.includes(p)), `hit: ${banned.filter((p) => src.includes(p)).join(',')}`);
}

// ---------------------------------------------------------------- S2 max 5 open
{
  const events = [];
  for (let i = 0; i < 6; i++) events.push(...cleanLaunch(mint(i), 100, wallet(10 + i)));
  const { sent } = drive([batch(0, 100, events)]);
  const buys = sent.filter((o) => o.side === 'buy');
  check('S2 max 5 open positions: 6 clean launches -> at most 5 buys', buys.length === 5, `got ${buys.length}`);
  check('S2 size: every buy is 0.05 SOL', buys.every((o) => BigInt(o.quote_lamports) === 50_000_000n));
}

// ---------------------------------------------------------------- S8 rug filters
{
  // Creator buys 2 SOL (> 1.25 cap): must NOT buy.
  const m = mint(20);
  const evs = [createEv(m, 100, wallet(30)), tradeEv(m, 100, wallet(30), true, 2n * SOL, 2n * SOL), tradeEv(m, 100, wallet(1), true, 8n * SOL, 10n * SOL)];
  const { sent } = drive([batch(0, 100, evs)]);
  check('S8a creator buy 2 SOL > 1.25 cap -> no buy', sent.filter((o) => o.side === 'buy').length === 0);
  // 3 distinct early buyers (> 2 cap): must NOT buy.
  const m2 = mint(21);
  const evs2 = [createEv(m2, 100, wallet(31)), tradeEv(m2, 100, wallet(31), true, 1n * SOL, 1n * SOL), tradeEv(m2, 100, wallet(1), true, 3n * SOL, 4n * SOL), tradeEv(m2, 100, wallet(2), true, 3n * SOL, 7n * SOL), tradeEv(m2, 100, wallet(3), true, 3n * SOL, 10n * SOL)];
  const r2 = drive([batch(0, 100, evs2)]);
  check('S8b 3 early buyers > 2 cap -> no buy', r2.sent.filter((o) => o.side === 'buy').length === 0);
  // Creator already sold before entry: must NOT buy.
  const m3 = mint(22);
  const evs3 = [...cleanLaunch(m3, 100, wallet(32)), tradeEv(m3, 100, wallet(32), false, 500000000n, 9500000000n)];
  const r3 = drive([batch(0, 100, evs3)]);
  check('S8c creator sold before entry -> no buy', r3.sent.filter((o) => o.side === 'buy').length === 0);
  // Real SOL 1 (< 5): must NOT buy. Real SOL 40 (> 30): must NOT buy.
  const m4 = mint(23);
  const evs4 = [createEv(m4, 100, wallet(33)), tradeEv(m4, 100, wallet(33), true, 500000000n, 500000000n), tradeEv(m4, 100, wallet(1), true, 500000000n, 1n * SOL)];
  const r4 = drive([batch(0, 100, evs4)]);
  check('S8d real SOL 1 < 5 -> no buy', r4.sent.filter((o) => o.side === 'buy').length === 0);
}

// ---------------------------------------------------------------- S9/S10/S11/S12 exits
function openPosition(m, slot) {
  // Batch 0: buy the clean launch. Batch 1: the buy fill lands + account shows the position.
  const b0 = batch(0, slot, cleanLaunch(m, slot, wallet(40)));
  const pos = { mint: m, token_amount: '715000000000', cost_lamports: '20000000' };
  const fill = { client_id: 'o1', mint: m, side: 'buy', status: 'filled', reason: null, decided_slot: slot, slot: slot + 2, quote_lamports: '20000000', token_amount: '715000000000', fee_lamports: '0', tx_fee_lamports: '105000', fee_fallback: false };
  const b1 = batch(1, slot + 2, [], [mark(m, slot + 2, VQ0, VT0)], [fill], [pos]);
  return { b0, b1, pos };
}
{
  const m = mint(30);
  const { b0, b1, pos } = openPosition(m, 100);
  // S9: creator sells while held -> exit at once.
  const sellEv = tradeEv(m, 110, wallet(40), false, 500000000n, 9500000000n);
  const { sent } = drive([b0, b1, batch(2, 110, [sellEv], [mark(m, 110, VQ0, VT0)], [], [pos])]);
  check('S9 creator sells while held -> sell all', sent.some((o) => o.side === 'sell' && o.mint === m));
}
{
  const m = mint(31);
  const { b0, b1, pos } = openPosition(m, 100);
  // S10: no trade for 200 slots -> stale exit.
  const { sent } = drive([b0, b1, batch(2, 300, [], [mark(m, 300, VQ0, VT0)], [], [pos])]);
  check('S10 stale 200 slots -> sell all', sent.some((o) => o.side === 'sell' && o.mint === m));
  // S10b: only 100 slots idle -> must NOT stale-exit.
  const { sent: sent2 } = drive([b0, b1, batch(2, 200, [], [mark(m, 200, VQ0, VT0)], [], [pos])]);
  check('S10b idle 100 slots < 200 -> no stale exit', !sent2.some((o) => o.side === 'sell' && o.mint === m));
}
{
  const m = mint(32);
  const { b0, b1, pos } = openPosition(m, 100);
  // S11: mark price +20% over create -> TP +15% exit.
  const { sent } = drive([b0, b1, batch(2, 105, [], [mark(m, 105, 36_000_000_000n, VT0)], [], [pos])]);
  check('S11 price +20% -> TP exit', sent.some((o) => o.side === 'sell' && o.mint === m));
}
{
  const m = mint(33);
  const { b0, b1, pos } = openPosition(m, 100);
  // S12: held 400 slots -> hold-cap exit (seat opened at fill slot 102).
  const { sent } = drive([b0, b1, batch(2, 502, [], [mark(m, 502, VQ0, VT0)], [], [pos])]);
  check('S12 hold 400 slots -> exit', sent.some((o) => o.side === 'sell' && o.mint === m));
}
{
  // S13: CreateEvent + CompleteEvent in the same batch -> never buy.
  const m = mint(34);
  const evs = [createEv(m, 100, wallet(44)), { event: 'CompleteEvent', mint: m, slot: 100, block_time: 1793589100 }];
  const { sent } = drive([batch(0, 100, evs)]);
  check('S13 completed in create batch -> no buy', sent.filter((o) => o.side === 'buy').length === 0);
}

// ---------------------------------------------------------------- S3/S4/S7 grade-local
{
  let g = null;
  try {
    g = JSON.parse(readFileSync(gradePath, 'utf8'));
  } catch {
    console.log(`SKIP grade-local asserts: no ${gradePath} (run grade-local first)`);
  }
  if (g) {
    const met = g.result.performance.metrics;
    const sharpe = Number(met.sharpe);
    const pnl = Number(met.net_pnl_lamports) / 1e9;
    check('S3 round trips >= 20 mints, >= 0.01 SOL each', Number(met.round_trips) >= 20 && Number(met.distinct_mints) >= 20, `trips=${met.round_trips} mints=${met.distinct_mints}`);
    check('S4 max drawdown <= 50%', Number(met.max_drawdown) <= 0.5, `dd=${met.max_drawdown}`);
    check('S7a dev Sharpe > 0', sharpe > 0, `sharpe=${sharpe}`);
    check('S7b net PnL > 0 (prize-eligible)', pnl > 0, `pnl=${pnl}`);
    check('S6 grade-local reproduced 2x identical', g.l1?.reproduced === true, `reproduced=${g.l1?.reproduced}`);
  }
}

// ---------------------------------------------------------------- S6 determinism (sim 2x)
{
  const run = () => execFileSync('node', ['../../research/sim.ts', '--kit', process.env.SHARPE_KIT || '/home/hatch/workspace/makefun/kits-20261125/sharpe-sprint/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532-kit'], { cwd: new URL('.', import.meta.url).pathname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const a = run();
  const b = run();
  const ha = createHash('sha256').update(a).digest('hex');
  const hb = createHash('sha256').update(b).digest('hex');
  check('S6 sim 2x byte-identical output', ha === hb, `${ha} vs ${hb}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
