// A cautious sniper for fresh pump.fun launches, on agent-fun/replay/v2.
// Written after the repo anchor (makefun anchor 403fada377130a30672ae53f838438e57eff3964 round 34316415).
//
// Idea: nearly every launch in the replay loses money, so the bot mostly sits
// in cash and only steps in when the opening tape looks clean. For each coin it
// watches from its CreateEvent: how much SOL the curve really holds, how much
// of the first slot the creator bought for themselves, how many unrelated
// wallets jumped in beside them (a crowd in slot zero is usually the creator's
// own cluster lining up a dump), whether the creator has already sold, and
// whether any outsider dumped hard. A launch that clears all of that gets one
// small buy; the bot then banks a quick gain, bails when the creator sells,
// walks away from a dead tape, or gives up after a bounded hold.
//
// How the numbers were picked (dev window, kit sims on the full 24 h window;
// proxy hourly Sharpe = mean/std of hourly mark-to-market equity returns):
//   pilot momentum -9.39 SOL, pilot reversion -4.02 SOL, pilot sniper -0.49 SOL
//   -> the sniper is the only pilot near breakeven, so it is the base.
//   stake 0.10 -> 0.02 SOL and real SOL 0.3 -> 5: -0.49 -> -0.058 (60 coins).
//   early buyers at most 3 -> 2: -0.058 -> -0.030 (26 coins).
//   tp 15% / sl 12% / hold 10 -> tp 15% / sl 50% / hold 400: -0.030 -> -0.0036.
//   A tight stop kept cutting positions that later recovered; the wide stop is
//   effectively switched off and exits happen on TP, creator sell, staleness,
//   or the hold cap instead.
//   creator buy at most 2.5 -> 1.25 SOL: -0.0036 -> +0.0246 (24 coins).
//   stale exit 1,000,000 -> 200 slots: +0.0246, 24 coins, proxy Sharpe 0.112.
//   Fill pacing OFF: the pilot splits orders to chase a 200-fill count, but
//   this bounty has no fill-count guardrail (only >=20 round trips), and each
//   split piece costs its own tx fee. Turning the split off: +0.0246 -> +0.0360
//   SOL, proxy Sharpe 0.112 -> 0.161, fills 151 -> 46, drawdown 0.0031.
//   Tried and rejected: partial take-profit, trailing stop, adding to winners,
//   flow / recent-buyer / minimum-creator-buy / run-up filters, tighter stops,
//   lower TP (8-12%), smaller stake (0.01-0.015 SOL), real SOL 3 or 10 - all
//   worse on proxy Sharpe and/or net PnL. Neighbourhood check: every cell of
//   stake {0.015, 0.02} x tp {10, 12, 15%} x hold {200, 400} with pacing off
//   is positive (+0.011..+0.036), so the pick sits on a flat positive patch,
//   not one lucky cell. Best coin +0.013 SOL; strip the top 3 coins and the
//   dev PnL is -0.012, so the edge is thin and spread over a few winners -
//   stay small and let them pay.
//
// The whole decision is a pure function of the batches it has seen: no clock,
// no dice, no network, no disk. Two runs on the same window produce identical
// action logs.

import {
  BPS,
  LAMPORTS_PER_SOL,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/agentfun-bot.ts';

/** One basis-point unit, as a plain number, for the tune table below. */
const BPS_NUM = 10_000;
/** Lamports in one SOL, as a plain number, so the tune table reads in SOL. */
const SOL = Number(LAMPORTS_PER_SOL);

export interface Tune {
  // --- sizing ------------------------------------------------------------
  /** Lamports aimed at per coin in total (each reply still capped at 1% of real SOL). */
  targetLamports: number;
  /** Smallest single buy worth paying a transaction fee for. */
  smallestBuy: number;
  // --- entry window ------------------------------------------------------
  /** Oldest age (slots since create) at which a first buy may still be decided. */
  entryLatest: number;
  // --- curve reserves ----------------------------------------------------
  /** Real SOL reserve window at decision time (lamports). */
  reserveLow: number;
  reserveHigh: number;
  // --- creator -----------------------------------------------------------
  /** Creator's own buys in the create slot: at most this many lamports. */
  makerBuyHigh: number;
  /** Creator sold before entry: skip the coin. */
  refuseMakerSold: boolean;
  // --- early crowd -------------------------------------------------------
  /** Distinct non-creator buyers before entry, at most: a launch bundled by many wallets is a dump in waiting. */
  buyersHigh: number;
  // --- exits -------------------------------------------------------------
  /** Exit when the position is worth this much over its cost (bps). */
  tpBps: number;
  /** Exit when it is worth this much under its cost (bps). */
  stopBps: number;
  /** Exit after holding this many slots. */
  holdMax: number;
  /** Exit when the creator sells while held. */
  leaveOnMakerSell: boolean;
  /** Exit when no trade has hit the coin for this many slots. */
  idleMax: number;
}

export const TUNE: Tune = {
  targetLamports: (2 * SOL) / 100,
  smallestBuy: (5 * SOL) / 1000,
  entryLatest: 3,
  reserveLow: 5 * SOL,
  reserveHigh: 30 * SOL,
  makerBuyHigh: (5 * SOL) / 4,
  refuseMakerSold: true,
  buyersHigh: 2,
  tpBps: 1500,
  stopBps: 5000,
  holdMax: 400,
  leaveOnMakerSell: true,
  idleMax: 200,
};

/** Everything remembered about one launch, from its CreateEvent onward. */
interface Launch {
  mint: Pubkey;
  bornSlot: number;
  maker: Pubkey;
  makerBuy: bigint;
  tradeCount: number;
  crowd: Set<Pubkey>;
  boughtLamports: bigint;
  soldLamports: bigint;
  worstSellBps: bigint;
  makerSold: boolean;
  lastSeenSlot: number;
  sends: number;
  spent: bigint;
  /** Never buy it again (exited, filtered out for good, or completed). */
  closed: boolean;
  finished: boolean;
}

/** An open position the bot is nursing toward an exit. */
interface Seat {
  openedSlot: number;
  feesPaid: bigint;
  makerSoldAtOpen: boolean;
}

/** Curve fee taken on a sale: protocol 95 bps + creator 30 bps. */
const FEE_BPS = 125n;

/** What selling `tokens` against (vq, vt) would pay after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(tune: Tune = TUNE) {
  const T = tune;
  const launches = new Map<Pubkey, Launch>();
  const seats = new Map<Pubkey, Seat>();
  /** Mints with a sell in flight. */
  const selling = new Set<Pubkey>();

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        launches.set(e.mint, {
          mint: e.mint,
          bornSlot: e.slot,
          maker: e.creator,
          makerBuy: 0n,
          tradeCount: 0,
          crowd: new Set(),
          boughtLamports: 0n,
          soldLamports: 0n,
          worstSellBps: 0n,
          makerSold: false,
          lastSeenSlot: e.slot,
          sends: 0,
          spent: 0n,
          closed: false,
          finished: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = launches.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.tradeCount += 1;
        c.lastSeenSlot = e.slot;
        const isMaker = e.user === c.maker;
        if (e.is_buy) {
          c.boughtLamports += sol;
          if (isMaker && e.slot === c.bornSlot) c.makerBuy += sol;
          else if (!isMaker) c.crowd.add(e.user);
        } else if (isMaker) {
          c.makerSold = true;
        } else {
          c.soldLamports += sol;
          const rqBefore = BigInt(e.real_quote_reserves) + sol;
          if (rqBefore > 0n) {
            const bps = (sol * BPS) / rqBefore;
            if (bps > c.worstSellBps) c.worstSellBps = bps;
          }
        }
      } else {
        const c = launches.get(e.mint);
        if (c !== undefined) {
          c.finished = true;
          c.closed = true;
        }
      }
    }
  }

  function pendingSide(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === side) return true;
    }
    return false;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      readEvents(batch);
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) {
        marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
      }

      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          // Force-close by the harness: the seat is gone.
          seats.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        const seat = seats.get(f.mint);
        if (f.status !== 'rejected' && seat !== undefined) {
          seat.feesPaid += BigInt(f.tx_fee_lamports);
        }
        if (f.side === 'buy' && f.status === 'filled' && seat === undefined) {
          seats.set(f.mint, {
            openedSlot: f.slot,
            feesPaid: BigInt(f.tx_fee_lamports),
            makerSoldAtOpen: launches.get(f.mint)?.makerSold ?? false,
          });
        }
      }
      for (const mint of [...selling]) {
        if (!pendingSide(state, mint, 'sell')) selling.delete(mint);
      }
      for (const mint of [...seats.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !pendingSide(state, mint, 'buy')) {
          seats.delete(mint);
        }
      }

      // Exits first.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = launches.get(mint);
        let seat = seats.get(mint);
        if (seat === undefined) {
          seat = { openedSlot: state.slot, feesPaid: tx, makerSoldAtOpen: c?.makerSold ?? false };
          seats.set(mint, seat);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + seat.feesPaid;
        let leave = false;
        if (basis > 0n) {
          if (value * BPS >= basis * (BPS + BigInt(T.tpBps))) leave = true;
          if (value * BPS <= basis * (BPS - BigInt(T.stopBps))) leave = true;
        }
        if (state.slot - seat.openedSlot >= T.holdMax) leave = true;
        if (c !== undefined) {
          if (T.leaveOnMakerSell && c.makerSold && !seat.makerSoldAtOpen) leave = true;
          if (state.slot - c.lastSeenSlot >= T.idleMax) leave = true;
        }
        if (!leave) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: BPS_NUM });
        selling.add(mint);
        if (c !== undefined) c.closed = true;
      }

      // Entries.
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let open = state.committedPositionCount();
      for (const c of launches.values()) {
        if (orders.length >= cap) break;
        if (c.closed || c.finished) continue;
        const age = state.slot - c.bornSlot;
        if (age > T.entryLatest) {
          c.closed = true;
          continue;
        }
        if (open >= state.hello.caps.max_open_positions) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        if (c.makerSold && T.refuseMakerSold) {
          c.closed = true;
          continue;
        }
        // Rug filter.
        const rq = curve.real_quote_reserves;
        if (rq < BigInt(T.reserveLow) || rq > BigInt(T.reserveHigh)) continue;
        if (c.makerBuy > BigInt(T.makerBuyHigh)) continue;
        if (c.crowd.size > T.buyersHigh) continue;
        if (c.boughtLamports > 0n && c.soldLamports * BPS > c.boughtLamports * BigInt(BPS_NUM)) continue;
        if (c.worstSellBps > BigInt(BPS_NUM)) continue;
        const room = BigInt(T.targetLamports) - c.spent;
        if (room < BigInt(T.smallestBuy)) continue;
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = room < maxBuy ? room : maxBuy;
        if (amount < BigInt(T.smallestBuy)) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: BPS_NUM });
        free -= amount + tx;
        c.sends += 1;
        c.spent += amount;
        open += 1;
      }
      return orders;
    },
  };
}
