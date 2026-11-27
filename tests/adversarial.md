# GATE-G — Uji adversarial per kalimat SPEC

Bounty: Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins
(`u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532`).
SPEC = `competition.yaml` (description + resolution.criteria) + `RULES.txt` kit.
Runner: `node tests/adversarial.mjs [--grade <grade-local-dev.json>]`
Hasil run 27 Nov 2026 ~11:50 WIB: **19 passed, 0 failed**.

## Kalimat SPEC → kasus uji

| # | Kalimat SPEC | Kasus adversarial | Diharapkan | Bukti |
|---|---|---|---|---|
| S1 | Paper trading only; replay pakai market data, never real funds | Grep main.ts + strategy.ts untuk fetch/http/fs/clock/random/env/git | Tidak ada satupun | S1 PASS (static) |
| S2 | Max 5 open positions | 6 launch bersih dalam 1 batch | Maks 5 buy @0,02 SOL | S2 PASS |
| S3 | Round trip ≥0,01 SOL di ≥20 mint berbeda | grade-local dev resmi | 23 trip / 23 mint | S3 PASS |
| S4 | Max drawdown 50% | grade-local dev resmi | DD 0,0035 ≤ 0,5 | S4 PASS |
| S5 | Semua yang dijalankan bot ada di repo (tanpa network/secret/git history) | Sama seperti S1 + repo hanya berisi main.ts, strategy.ts, vendor/, tests/, README, LICENSE, owner.json | Tidak ada baca di luar repo | S1 PASS; `git log` repo bersih (lihat BUILD-NOTES) |
| S6 | Bot dijalankan 2x; dua action log identik byte-per-byte | (a) grade-local l1.reproduced; (b) sim dijalankan 2x, bandingkan sha256 stdout | Identik | S6 PASS ×2 |
| S7 | Ranking hourly Sharpe; net PnL > 0 syarat lolos hadiah | grade-local dev resmi | Sharpe 0,156 > 0; PnL +0,027 SOL > 0 | S7a/S7b PASS |
| S8 | Rug filter: creator buy, crowd awal, creator jual, real SOL | (a) creator buy 2 SOL; (b) 3 buyer awal; (c) creator sudah jual; (d) real SOL 1 | Keempatnya: NO BUY | S8a–d PASS |
| S9 | Exit saat creator jual saat posisi dipegang | Posisi terbuka + TradeEvent sell oleh creator | Sell all | S9 PASS |
| S10 | Exit saat tape mati (stale) | Posisi terbuka + 200 slot tanpa trade; kontrol 100 slot | Sell di 200, tidak di 100 | S10/S10b PASS |
| S11 | Take-profit +15% | Posisi terbuka + mark +20% dari harga create | Sell (TP) | S11 PASS |
| S12 | Hold cap 400 slot | Posisi terbuka + slot maju 400 sejak fill | Sell | S12 PASS |
| S13 | Coin complete tidak lagi ditrade | CreateEvent + CompleteEvent di batch yang sama | No buy | S13 PASS |
| S14 | Tanpa short / leverage | Harness caps shorts=false, leverage=false; bot hanya kirim buy + sell posisi yang dipegang; grade-local rejected 0 | Tidak ada short | S2 (buy-only entries) + grade-local rejected 0 |

## Yang TIDAK bisa diuji lokal (house-side)
- Jendela final 6 jam direkam SETELAH entries tutup: tidak ada datanya di dev;
  yang diuji adalah perilaku yang sama pada dev window 24 jam.
- Rumus Sharpe house tidak dipublikasi; proxy lokal (mean/std return jam
  mark-to-market) = 0,161 vs resmi dev 0,156 — dekat, tapi keputusan submit
  memakai angka resmi grade-local + stress, bukan proxy.
- Ranking akhir vs 1.792 entri lain: hanya server yang tahu.

## Cara unit test bekerja
Strategi didorong langsung lewat `BotState` vendored (kelas yang sama dipakai
`runBot` grader) dengan batch sintetis: CreateEvent + TradeEvent pembuka yang
membentuk launch bersih (creator 1 SOL + 2 outsider 4,5 SOL → real SOL 10),
lalu fill + account untuk membuka posisi. Tidak ada network/jam/random.
