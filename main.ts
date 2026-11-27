// Sharpe Sprint entry: a cautious pump.fun launch sniper.
// Written after the repo anchor (makefun anchor 403fada377130a30672ae53f838438e57eff3964 round 34316415).
// Run by the grader as `node /bot/main.ts`; the strategy lives in strategy.ts,
// the protocol in the vendored SDK shim (vendor/agentfun-bot.ts, a byte-identical
// copy of the kit's sdk/ts file).

import { runBot } from './vendor/agentfun-bot.ts';
import { createStrategy, TUNE } from './strategy.ts';

const strategy = createStrategy(TUNE);

await runBot({
  onBatch: (state, batch) => strategy.onBatch(state, batch),
});
