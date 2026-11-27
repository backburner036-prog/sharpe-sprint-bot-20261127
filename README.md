# Sharpe Sprint Bot — Pump.fun Paper Bot

[![Bounty](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/backburner036-prog/sharpe-sprint-bot-20261127/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/backburner036-prog/sharpe-sprint-bot-20261127/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for the [Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) bounty on [make.fun](https://make.fun). It trades paper SOL on a 6-hour pump.fun replay; places go by **hourly Sharpe ratio**, not raw PnL — steady, controlled gains beat one lucky moonshot.

## Strategy

A cautious launch sniper (see `strategy.ts` for the full reasoning):

- Mostly sits in cash; only buys a fresh launch when the opening tape looks clean: real SOL 5–30, creator's own buy ≤ 1.25 SOL, at most 2 early non-creator buyers, creator hasn't sold, no outsider dump.
- One small buy per coin: **0.05 SOL** (0.5% of the 10 SOL paper capital; raised from 0.02 SOL on 27 Nov 2026 — the per-tx fee is fixed at 105k lamports, so a bigger stake shrinks the fee share; see `strategy.ts` header for the measured selection).
- Exits on take-profit +15%, a wide 50% stop (effectively off — exits happen on TP, creator sell, staleness, or the hold cap instead), hold cap 400 slots, stale exit after 200 slots without a trade, and immediately when the creator sells while held.
- **No fill splitting**: the pilot splits orders to chase a fill count this bounty doesn't require; each split piece costs its own tx fee. Turning it off improved dev net PnL +0.0246 → +0.0360 SOL (sim) and proxy Sharpe 0.112 → 0.161.
- Fully deterministic: a pure function of the batches it is fed — no clock, no randomness, no network, no disk. Two runs produce byte-identical action logs.

## Dev results (grade-local, `--driver process`, official)

- **Hourly Sharpe: 0.1583** · **Net PnL: +0.0688 SOL** · Max drawdown 0.0083 · Win rate 60.9%
- 23 round trips / 23 distinct mints · 46 fills · 0 rejected · 1 failed tx
- Reproduced: two runs identical (`reproduced: true`)
- Top-3 coins = 43.4% of gains; net without top 3: −0.0242 SOL — the edge is thin and spread over a few winners.
- 90% interval on PnL: −0.065/+0.205 SOL (contains 0 — the PnL is not statistically significant on one 24 h window); at 2× fees: +0.0336 SOL.
- Stress (20 rebuilt copies): see `BUILD-NOTES` in the workspace (median Sharpe, P10/P90, losing copies, dev rank).

## Layout

- `main.ts` — entrypoint (Node 22), wires the strategy into the replay harness.
- `strategy.ts` — the sniper: tune table, launch tracking, entries, exits.
- `vendor/agentfun-bot.ts` — vendored protocol shim (byte-identical copy of the kit's `sdk/ts/makefun-bot.ts`).
- `tests/adversarial.md` + `tests/adversarial.mjs` — GATE-G: one runnable adversarial case per SPEC sentence (19 checks, all passing).

## Run the tests

```sh
node tests/adversarial.mjs --grade <grade-local-dev.json>
```
