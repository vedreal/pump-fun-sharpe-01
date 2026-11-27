// Calm Climber — a Sharpe-first paper-trading bot for pump.fun bonding curves.
//
// Idea: Sharpe rewards a smooth equity curve, not one lucky moonshot. This bot
// buys flat, low-volatility accumulation bases — coins whose price barely moved
// over the last 10 trades, never dipped hard inside the window, and whose tape
// is dominated by buyers (buy volume > 1.5x sell volume) — i.e. quiet accumulation
// before the spike, not the spike itself. It stakes a small fixed 0.05 SOL and
// exits on a wide take-profit (+25%, so the trailing rule banks runners),
// a tight stop (-6%), a trailing give-back rule, or a time cap, so the equity
// curve grinds in small steps instead of swinging. A portfolio drawdown guard
// pauses new entries at -8% equity vs peak. Paper trading only: no real money,
// no wallet, no network.
//
// Fully deterministic: every decision is a pure function of the batch, the state
// and the tape the bot built itself. No clock, no environment, no Math.random.
// Iteration order is always first-seen / insertion order, never hash order.
//
// Backtested on the kit's 24h dev dataset (custom replay simulator in
// tools/backtest.mjs): the base-entry variant was the most robust of six entry
// styles tried (momentum, dip, early, hold, base, spike) — smallest 24h loss
// (-0.26 SOL) and best 24h hourly Sharpe (-0.41), and the only variant with a
// positive 6h window (+0.03 SOL, Sharpe +0.53). The dev market drifts down
// hard (median coin -26% in the hour after its 10th trade), so no long-only
// variant was net positive on dev; this one bleeds the least and keeps the
// equity curve smoothest, which is what the hourly-Sharpe ranking rewards.

import type {
  Batch,
  BotState,
  BuyInput,
  OrderInput,
  SellInput,
} from './vendor/makefun-bot.ts';

const LAMPORTS_PER_SOL = 1_000_000_000n;

// --- sizing ---------------------------------------------------------------
// (STAKE_LAMPORTS, TAKE_PROFIT_BPS, STOP_LOSS_BPS, ENTRY_RISE_BPS and
// TIME_EXIT_MAX_SLOTS live in createStrategy's opts so backtests can sweep
// them; the defaults below are the shipped values.)
const MIN_BUY_LAMPORTS = 10_000_000n; // guardrail round trip floor: 0.01 SOL
const MAX_SLIPPAGE_BUY_BPS = 500; // 5%: skip a buy whose fill moved too far
const MAX_SLIPPAGE_SELL_BPS = 10_000; // exits must execute, even in a fast tape

// --- entry filter ---------------------------------------------------------
const ENTRY_PEAK_GAP_BPS = 300; // price within 3% of its running peak (strength, not a dip)
const ENTRY_REAL_MIN_LAMPORTS = 1_000_000_000n; // >= 1 SOL real reserves (liquidity + cap room)
const ENTRY_REAL_MAX_LAMPORTS = 40_000_000_000n; // <= 40 SOL (stay away from migration zone)

// --- exits ----------------------------------------------------------------
// (TRAIL_TRIGGER_BPS, TRAIL_GIVEBACK_BPS, TIME_EXIT_SLOTS and
// TIME_EXIT_PROFIT_BPS live in createStrategy's opts so backtests can sweep
// them; the defaults above are the shipped values.)

// --- portfolio guard ------------------------------------------------------
const GUARD_PAUSE_BPS = 800; // pause new entries at -8% equity vs peak
const GUARD_RESUME_BPS = 400; // resume once back within -4% of peak

interface Trade {
  p: number; // SOL per token after this trade
  buy: boolean;
  vol: number; // SOL volume of this trade
}

interface Tape {
  /** Last LOOKBACK_TRADES+1 trades, oldest first. */
  trades: Trade[];
  peak: number;
  tradesTotal: number;
  realQuote: bigint;
  lastPrice: number;
}

interface Held {
  entryPrice: number; // SOL per token paid (from the buy fill)
  peakPrice: number; // best SOL per token seen since entry
  entrySlot: number; // slot the buy was decided on
}

export interface StrategyOpts {
  stakeLamports?: bigint;
  takeProfitBps?: number;
  stopLossBps?: number;
  entryRiseBps?: number;
  timeExitMaxSlots?: number;
  trailTriggerBps?: number;
  trailGivebackBps?: number;
  timeExitSlots?: number;
  timeExitProfitBps?: number;
  /** 'momentum': buy steady strength. 'dip': buy a stabilizing pullback with buy flow returning.
   *  'early': buy very young coins on the first readable tape (lottery-ticket profile).
   *  'hold': buy every coin once as soon as the size cap allows, never sell (equal-weight baseline).
   *  'base': buy a flat, low-volatility accumulation base with buy flow dominant,
   *  before the spike (wide take-profit, tight stop).
   *  'spike': buy around trade 10 when buyers dominate the tape, ride ~6 minutes,
   *  then exit unconditionally (the spike window). */
  entryMode?: 'momentum' | 'dip' | 'early' | 'hold' | 'base' | 'spike';
  /** Lookback window in trades for momentum/dip filters (default 10). */
  lookbackTrades?: number;
  /** Momentum only: the tape's lowest price over the lookback may not sit more than this
   *  below the window-start price (smooth rise, no violent dip inside the move). 10000 = off. */
  smoothDipBps?: number;
  /** Buy flow must beat sell flow by this ratio (bps): buyVol*10000 > sellVol*buyFlowBps. */
  buyFlowBps?: number;
  /** 'spike' mode: minimum buy share (bps) over the lookback window (default 6000 = 60%). */
  spikeBuyShareBps?: number;
  /** Optional counters the bot increments (backtest diagnostics only). */
  debug?: {
    exits?: { tp: number; sl: number; trail: number; timeProfit: number; timeMax: number };
    entries?: { considered: number; noMomentum: number; offPeak: number; sellFlow: number; capTooSmall: number };
  };
}

export function createStrategy(opts: StrategyOpts = {}) {
  const STAKE_LAMPORTS = opts.stakeLamports ?? 50_000_000n;
  const TAKE_PROFIT_BPS = opts.takeProfitBps ?? 2_500;
  const STOP_LOSS_BPS = opts.stopLossBps ?? 600;
  const ENTRY_RISE_BPS = opts.entryRiseBps ?? 400;
  const TIME_EXIT_MAX_SLOTS = opts.timeExitMaxSlots ?? 14_400;
  const ENTRY_MODE = opts.entryMode ?? 'base';
  const SMOOTH_DIP_BPS = opts.smoothDipBps ?? 10_000;
  const BUY_FLOW_BPS = opts.buyFlowBps ?? 10_000;
  const SPIKE_BUY_SHARE_BPS = opts.spikeBuyShareBps ?? 6_000;
  const LOOKBACK_TRADES = opts.lookbackTrades ?? 10; // momentum measured over the last N trades
  const TRAIL_TRIGGER_BPS = opts.trailTriggerBps ?? 600; // once +6%, trail the peak...
  const TRAIL_GIVEBACK_BPS = opts.trailGivebackBps ?? 300; // ...and sell on a 3% give-back from the peak
  const TIME_EXIT_SLOTS = opts.timeExitSlots ?? 3_600; // ~13 min: bank a small win instead of sitting
  const TIME_EXIT_PROFIT_BPS = opts.timeExitProfitBps ?? 200; // ...when up >= 2%
  const tapes = new Map<string, Tape>();
  const held = new Map<string, Held>();
  const exited = new Set<string>(); // one trade per mint per run: no whipsaw re-entries
  const buyPending = new Set<string>(); // mints with a buy order still in flight (fill not yet seen)
  const selling = new Set<string>(); // mints with a sell order still in flight
  let peakEquity = 10_000_000_000; // lamports; starts at the 10 SOL capital
  let guardPaused = false;

  function tapeFor(mint: string): Tape {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { trades: [], peak: 0, tradesTotal: 0, realQuote: 0n, lastPrice: 0 };
      tapes.set(mint, t);
    }
    return t;
  }

  function priceOf(vQuote: bigint, vToken: bigint): number {
    if (vToken === 0n) return 0;
    return Number(vQuote) / Number(vToken);
  }

  return function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const txFee = state.txFeeLamports();
    const boughtThisBatch = new Set<string>(); // one buy per mint per batch (a mint can appear in several events of one batch)

    // 1. Learn from fills: record entry prices on buy fills, forget sold coins.
    // A rejected sell frees the mint for another exit attempt next batch.
    for (const f of batch.fills) {
      if (f.side === 'buy') buyPending.delete(f.mint);
      if (f.side === 'sell') selling.delete(f.mint);
      if (f.status !== 'filled') continue;
      if (f.side === 'buy') {
        const tokens = Number(BigInt(f.token_amount));
        const spent = Number(BigInt(f.quote_lamports));
        if (tokens > 0 && spent > 0) {
          held.set(f.mint, { entryPrice: spent / tokens, peakPrice: spent / tokens, entrySlot: f.decided_slot });
        }
      } else {
        held.delete(f.mint);
        exited.add(f.mint);
      }
    }

    // 2. Update the tape from this batch's events.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const t = tapeFor(e.mint);
        t.lastPrice = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        t.realQuote = 0n;
      } else if (e.event === 'TradeEvent') {
        const t = tapeFor(e.mint);
        const p = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        t.lastPrice = p;
        t.tradesTotal += 1;
        if (p > t.peak) t.peak = p;
        t.trades.push({ p, buy: e.is_buy, vol: Number(BigInt(e.sol_amount)) / 1_000_000_000 });
        if (t.trades.length > LOOKBACK_TRADES + 1) t.trades.shift();
        t.realQuote = BigInt(e.real_quote_reserves);
      }
    }

    // 3. Sync held book with the account (the harness may close a position on
    // curve completion without a sell order from us).
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint)) held.delete(mint);
    }

    // 4. Mark-to-market equity and the drawdown guard.
    // Prefer the batch marks (freshest reserves) for held mints, else the tape.
    const markPrice = new Map<string, number>();
    for (const m of batch.marks) {
      markPrice.set(m.mint, priceOf(BigInt(m.virtual_quote_reserves), BigInt(m.virtual_token_reserves)));
    }
    let equity = Number(state.cash);
    for (const [mint, pos] of state.positions) {
      const p = markPrice.get(mint) ?? tapes.get(mint)?.lastPrice ?? 0;
      equity += Number(pos.token_amount) * p;
    }
    if (equity > peakEquity) peakEquity = equity;
    const drawdownBps = peakEquity > 0 ? Math.floor(((peakEquity - equity) * 10_000) / peakEquity) : 0;
    if (!guardPaused && drawdownBps >= GUARD_PAUSE_BPS) guardPaused = true;
    else if (guardPaused && drawdownBps <= GUARD_RESUME_BPS) guardPaused = false;

    // 5. Exits first: take profit, stop loss, trailing give-back, time caps.
    // ('hold' mode never sells: it is the equal-weight baseline.)
    if (ENTRY_MODE !== 'hold') {
    for (const [mint, pos] of state.positions) {
      const h = held.get(mint);
      if (h === undefined) continue; // entry fill not seen yet; cannot price the exit
      if (selling.has(mint)) continue; // an exit is already in flight
      const p = markPrice.get(mint) ?? tapes.get(mint)?.lastPrice ?? 0;
      if (p <= 0) continue;
      if (p > h.peakPrice) h.peakPrice = p;
      const pnlBps = Math.floor(((p - h.entryPrice) * 10_000) / h.entryPrice);
      const peakBps = Math.floor(((h.peakPrice - h.entryPrice) * 10_000) / h.entryPrice);
      const age = batch.slot - h.entrySlot;
      let sell = false;
      if (pnlBps >= TAKE_PROFIT_BPS) { sell = true; if (opts.debug?.exits) opts.debug.exits.tp += 1; } // bank the win
      else if (pnlBps <= -STOP_LOSS_BPS) { sell = true; if (opts.debug?.exits) opts.debug.exits.sl += 1; } // cut the loss
      else if (peakBps >= TRAIL_TRIGGER_BPS && p <= h.peakPrice * (1 - TRAIL_GIVEBACK_BPS / 10_000)) { sell = true; if (opts.debug?.exits) opts.debug.exits.trail += 1; }
      else if (age >= TIME_EXIT_MAX_SLOTS) { sell = true; if (opts.debug?.exits) opts.debug.exits.timeMax += 1; } // recycle dead money
      else if (age >= TIME_EXIT_SLOTS && pnlBps >= TIME_EXIT_PROFIT_BPS) { sell = true; if (opts.debug?.exits) opts.debug.exits.timeProfit += 1; }
      if (sell) {
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: MAX_SLIPPAGE_SELL_BPS } as SellInput);
        selling.add(mint);
      }
    }
    }

    // 6. Entries: only fresh, strong, buy-driven tapes; small fixed stake.
    if (!guardPaused) {
      for (const e of batch.events) {
        if (e.event !== 'TradeEvent') continue;
        const mint = e.mint;
        if (state.positions.has(mint) || exited.has(mint) || boughtThisBatch.has(mint) || buyPending.has(mint)) continue;
        if (state.committedPositionCount() + boughtThisBatch.size >= state.hello.caps.max_open_positions) break;
        if (orders.length >= state.hello.caps.max_orders_per_batch) break;
        const t = tapes.get(mint);
        if (t === undefined) continue;
        if (opts.debug?.entries) opts.debug.entries.considered += 1;

        // Shared liquidity gate: enough real reserves for a meaningful cap,
        // far enough from the migration zone. ('hold' buys as soon as the cap
        // allows, like the equal-weight baseline.)
        if (ENTRY_MODE !== 'hold' && (t.realQuote < ENTRY_REAL_MIN_LAMPORTS || t.realQuote > ENTRY_REAL_MAX_LAMPORTS)) {
          if (opts.debug?.entries) opts.debug.entries.capTooSmall += 1;
          continue;
        }
        const now = t.lastPrice;
        if (now <= 0) continue;

        let pass = false;
        if (ENTRY_MODE === 'early') {
          // Very young coin, first readable tape: catch the move from the start.
          pass = t.tradesTotal >= 3 && t.tradesTotal <= 14;
        } else if (ENTRY_MODE === 'spike') {
          // Around trade 10, buyers dominate the tape: ride the spike window.
          if (t.trades.length >= LOOKBACK_TRADES + 1 && t.tradesTotal >= 8 && t.tradesTotal <= 20) {
            let buys = 0;
            for (const tr of t.trades) if (tr.buy) buys += 1;
            pass = buys * 10_000 >= t.trades.length * SPIKE_BUY_SHARE_BPS;
            if (!pass && opts.debug?.entries) opts.debug.entries.noMomentum += 1;
          }
        } else if (ENTRY_MODE === 'hold') {
          // Equal-weight baseline: buy once as soon as the size cap allows.
          pass = t.tradesTotal >= 1;
        } else if (ENTRY_MODE === 'base') {
          // Flat accumulation base: price barely moved over the window, never
          // dipped hard, buyers dominate the flow. The spike usually comes next.
          if (t.trades.length >= LOOKBACK_TRADES + 1) {
            const ago = t.trades[0].p;
            let buyVol = 0;
            let sellVol = 0;
            let low = Infinity;
            let high = 0;
            for (const tr of t.trades) {
              if (tr.buy) buyVol += tr.vol;
              else sellVol += tr.vol;
              if (tr.p < low) low = tr.p;
              if (tr.p > high) high = tr.p;
            }
            const driftBps = ago > 0 ? Math.floor(((now - ago) * 10_000) / ago) : 0;
            pass =
              ago > 0 &&
              driftBps >= -500 &&
              driftBps <= 500 &&
              high > 0 &&
              low >= high * 0.95 &&
              buyVol * 10_000 > sellVol * 15_000;
            if (!pass && opts.debug?.entries) opts.debug.entries.noMomentum += 1;
          }
        } else if (t.trades.length >= LOOKBACK_TRADES + 1) {
          const ago = t.trades[0].p;
          if (ago > 0) {
            let buyVol = 0;
            let sellVol = 0;
            let low = Infinity;
            for (const tr of t.trades) {
              if (tr.buy) buyVol += tr.vol;
              else sellVol += tr.vol;
              if (tr.p < low) low = tr.p;
            }
            if (ENTRY_MODE === 'momentum') {
              const riseBps = Math.floor(((now - ago) * 10_000) / ago);
              const smooth = low >= ago * (1 - SMOOTH_DIP_BPS / 10_000);
              pass =
                riseBps >= ENTRY_RISE_BPS &&
                smooth &&
                now >= t.peak * (1 - ENTRY_PEAK_GAP_BPS / 10_000) &&
                buyVol * 10_000 > sellVol * BUY_FLOW_BPS;
              if (!pass && opts.debug?.entries) {
                if (riseBps < ENTRY_RISE_BPS || !smooth) opts.debug.entries.noMomentum += 1;
                else if (now < t.peak * (1 - ENTRY_PEAK_GAP_BPS / 10_000)) opts.debug.entries.offPeak += 1;
                else opts.debug.entries.sellFlow += 1;
              }
            } else {
              // dip: price fell over the window but is bouncing off its low with
              // buyers returning in the last few trades.
              const dropBps = Math.floor(((ago - now) * 10_000) / ago);
              const recent = t.trades.slice(-5);
              let recentBuys = 0;
              let recentBuyVol = 0;
              let recentSellVol = 0;
              for (const tr of recent) {
                if (tr.buy) { recentBuys += 1; recentBuyVol += tr.vol; }
                else recentSellVol += tr.vol;
              }
              pass =
                dropBps >= 300 &&
                dropBps <= 1_200 &&
                now >= low * 1.01 &&
                recentBuys >= 3 &&
                recentBuyVol > recentSellVol;
              if (!pass && opts.debug?.entries) opts.debug.entries.noMomentum += 1;
            }
          }
        }
        if (!pass) continue;

        const cap = state.maxBuyLamports(mint);
        if (cap < MIN_BUY_LAMPORTS) {
          if (opts.debug?.entries) opts.debug.entries.capTooSmall += 1;
          continue;
        }
        const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
        if (state.freeCashLamports() - BigInt(boughtThisBatch.size) * (STAKE_LAMPORTS + txFee) < amount + txFee) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: MAX_SLIPPAGE_BUY_BPS } as BuyInput);
        boughtThisBatch.add(mint);
        buyPending.add(mint);
      }
    }

    return orders;
  };
}
