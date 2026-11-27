// Calm Climber — a Sharpe-first paper-trading bot for pump.fun bonding curves.
//
// Entrypoint for the make.fun pumpfun-replay/v2 harness: `node /bot/main.ts`
// on Node 22. The strategy lives in strategy.ts; this file only wires it to
// the vendored SDK shim (vendor/makefun-bot.ts, a byte-identical copy of the
// kit's sdk/ts/makefun-bot.ts).
//
// How it trades: it buys flat, low-volatility accumulation bases — coins whose
// price barely moved over the last 10 trades, never dipped hard inside the
// window, and whose tape is dominated by buyers — i.e. quiet accumulation
// before the spike, not the spike itself. It stakes a small fixed 0.05 SOL,
// and exits on a wide take-profit (+25%, so the trailing rule banks runners),
// a tight stop (-6%), a trailing give-back rule, and time caps — so the equity
// curve grinds upward in small steps instead of swinging. A drawdown guard
// pauses new entries at -8% equity vs peak. Paper trading only: no real money,
// no wallet, no network.
// Fully deterministic: no clock, no environment, no Math.random.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy } from './strategy.ts';

await runBot({ onBatch: createStrategy() });
