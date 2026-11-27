// Dev backtest for the Calm Climber bot: replays the kit's dev dataset through
// the real SDK BotState + the strategy, simulating the pumpfun-replay/v2
// harness (constant-product bonding curve, 95+30 bps curve fees, 5k+100k
// lamports tx fee, 2-slot latency, 2% seeded failed tx, max 5 positions,
// 100 bps of real reserve per buy, 16 orders per batch).
//
// Usage:
//   node tools/backtest.mjs [startHour=0] [hours=6] [stakeSol=0.05] [tpBps=800] [slBps=500] [riseBps=400] [mode=momentum] [smoothDipBps=10000] [buyFlowBps=10000]
// startHour/hours select a window of the 24h dev dataset (block_time based).
// The bot only sees batches inside the window, like the real final run; the
// simulator pre-rolls the curve state from earlier events so reserves are right.

import fs from 'node:fs';
import zlib from 'node:zlib';
import { BotState } from '../vendor/makefun-bot.ts';
import { createStrategy } from '../strategy.ts';

const KIT = '/home/hatch/workspace/makefun/kit-pump-fun-sharpe/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532-kit';
const LAMPORTS_PER_SOL = 1_000_000_000n;
const BPS = 10_000n;
const TX_FEE = 105_000n; // base 5,000 + priority 100,000
const CURVE_FEE_BPS = 125n; // protocol 95 + creator 30
const SEED = '1';

const [startHour = 0, hours = 6, stakeSol = 0.05, tpBps = 800, slBps = 500, riseBps = 400, mode = 'momentum', smoothDipBps = 10000, buyFlowBps = 10000, lookback = 10, latency = 2, trailTrigger = 600, trailGiveback = 300, timeExitSlots = 3600, timeExitProfit = 200, timeExitMax = 14400, spikeShare = 6000] =
  process.argv.slice(2).map((v, i) => (i < 2 || i > 5 ? v : Number(v)));
const startHourN = Number(startHour);
const hoursN = Number(hours);
const stakeSolN = Number(stakeSol);
const tpBpsN = Number(tpBps);
const slBpsN = Number(slBps);
const riseBpsN = Number(riseBps);
const smoothDipBpsN = Number(smoothDipBps);
const buyFlowBpsN = Number(buyFlowBps);
const lookbackN = Number(lookback);
const latencyN = Number(latency);
const trailTriggerN = Number(trailTrigger);
const trailGivebackN = Number(trailGiveback);
const timeExitSlotsN = Number(timeExitSlots);
const timeExitProfitN = Number(timeExitProfit);
const timeExitMaxN = Number(timeExitMax);
const spikeShareN = Number(spikeShare);

function fnv(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 100;
}

// --- load events -----------------------------------------------------------
const events = [];
for (const part of ['part-00000', 'part-00001', 'part-00002']) {
  const raw = zlib.gunzipSync(fs.readFileSync(`${KIT}/dataset/events/${part}.ndjson.gz`)).toString();
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const e = JSON.parse(line);
    e._t = e.block_time ?? Number(e.timestamp);
    events.push(e);
  }
}
events.sort((a, b) => a.slot - b.slot); // stable: file order kept inside a slot
const firstTs = events[0]._t;
const windowStart = firstTs + startHourN * 3600;
const windowEnd = windowStart + hoursN * 3600;

// --- simulator state -------------------------------------------------------
const curves = new Map(); // mint -> {vT,vQ,rT,rQ,complete}
let cash = 10_000_000_000n;
const positions = new Map(); // mint -> {tokens, cost}
let completeSeq = 0;

function curveFor(mint) {
  let c = curves.get(mint);
  if (!c) {
    c = { vT: 0n, vQ: 0n, rT: 0n, rQ: 0n, complete: false };
    curves.set(mint, c);
  }
  return c;
}

function applyEventToCurve(e) {
  const c = curveFor(e.mint);
  if (e.event === 'CreateEvent') {
    c.vT = BigInt(e.virtual_token_reserves);
    c.vQ = BigInt(e.virtual_quote_reserves);
    c.rT = BigInt(e.real_token_reserves);
    c.rQ = 0n;
  } else if (e.event === 'TradeEvent') {
    c.vT = BigInt(e.virtual_token_reserves);
    c.vQ = BigInt(e.virtual_quote_reserves);
    c.rT = BigInt(e.real_token_reserves);
    c.rQ = BigInt(e.real_quote_reserves);
  } else if (e.event === 'CompleteEvent') {
    c.complete = true;
  }
}

// pre-roll curves to the window start
for (const e of events) {
  if (e._t >= windowStart) break;
  applyEventToCurve(e);
}

// --- harness ---------------------------------------------------------------
const hello = {
  type: 'hello',
  protocol: 'agent-fun/replay/v2',
  seed: SEED,
  universe: { program: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', quote: 'SOL', mayhem: 'excluded', exclude_cashback: true, sample: { hash: 'sha256', modulus: 16, residue: 15 } },
  capital: { lamports: '10000000000' },
  caps: { max_open_positions: 5, max_order_bps_of_real_reserve: 100, max_orders_per_batch: 16, shorts: false, leverage: false },
  latency_slots: 2,
  fees: { protocol_bps_fallback: 95, creator_bps_fallback: 30, base_fee_lamports: '5000', priority_fee_lamports: '100000', failed_tx_bps: 200 },
};

const state = new BotState(hello);
const debug = { exits: { tp: 0, sl: 0, trail: 0, timeProfit: 0, timeMax: 0 }, entries: { considered: 0, noMomentum: 0, offPeak: 0, sellFlow: 0, capTooSmall: 0 } };
const onBatch = createStrategy({
  stakeLamports: BigInt(Math.round(stakeSolN * 1e9)),
  takeProfitBps: tpBpsN,
  stopLossBps: slBpsN,
  entryRiseBps: riseBpsN,
  entryMode: mode,
  smoothDipBps: smoothDipBpsN,
  buyFlowBps: buyFlowBpsN,
  lookbackTrades: lookbackN,
  trailTriggerBps: trailTriggerN,
  trailGivebackBps: trailGivebackN,
  timeExitSlots: timeExitSlotsN,
  timeExitProfitBps: timeExitProfitN,
  timeExitMaxSlots: timeExitMaxN,
  spikeBuyShareBps: spikeShareN,
  debug,
});

const pending = []; // {order, decidedSlot, vTd, vQd, seq}
let seq = 0;
const fillsBySlot = new Map(); // slot -> fills resolved that slot
const equitySeries = []; // [t, equityLamports]
const stats = { buys: 0, sells: 0, rejected: 0, failed: 0, wins: 0, losses: 0, winLamports: 0n, lossLamports: 0n, rejectReasons: {} };
const mintBuys = new Map(); // mint -> total buy lamports
const mintSold = new Set();
let completeCloses = 0;

function priceOf(c) {
  return c.vT === 0n ? 0 : Number(c.vQ) / Number(c.vT);
}

function equityNow() {
  let eq = Number(cash);
  for (const [mint, p] of positions) {
    const c = curves.get(mint);
    if (c) eq += Number(p.tokens) * priceOf(c);
  }
  return eq;
}

function doBuy(order, decidedSlot, fills) {
  const c = curves.get(order.mint);
  const Q = BigInt(order.quote_lamports);
  const fail = (m) => {
    stats.rejected += 1;
    stats.rejectReasons[m] = (stats.rejectReasons[m] ?? 0) + 1;
    fills.push({ client_id: order.client_id, mint: order.mint, side: 'buy', status: 'rejected', reason: m, decided_slot: decidedSlot, slot: order._slot, quote_lamports: '0', token_amount: '0', fee_lamports: '0', tx_fee_lamports: '0', fee_fallback: false });
  };
  if (!c || c.complete) return fail('token_complete');
  if (Q === 0n) return fail('zero_amount');
  if (cash < Q + TX_FEE) return fail('insufficient_cash');
  const committed = new Set(positions.keys());
  for (const p of pending) if (p.order.side === 'buy') committed.add(p.order.mint);
  if (!positions.has(order.mint) && committed.size >= 5) return fail('max_open_positions');
  const cap = (c.rQ * 100n) / BPS;
  if (Q > cap) return fail('max_order_size');
  if (fnv(order.client_id + SEED) < 2) {
    stats.failed += 1;
    cash -= TX_FEE;
    fills.push({ client_id: order.client_id, mint: order.mint, side: 'buy', status: 'failed', reason: null, decided_slot: decidedSlot, slot: order._slot, quote_lamports: '0', token_amount: '0', fee_lamports: '0', tx_fee_lamports: TX_FEE.toString(), fee_fallback: false });
    return;
  }
  const fee = (Q * CURVE_FEE_BPS) / BPS;
  const qNet = Q - fee;
  const tokens = (c.vT * qNet) / (c.vQ + qNet);
  const exp = (order.vTd * qNet) / (order.vQd + qNet);
  if (tokens < (exp * BigInt(10_000 - order.max_slippage_bps)) / 10_000n) return fail('max_slippage');
  c.vQ += qNet;
  c.vT -= tokens;
  c.rQ += qNet;
  c.rT -= tokens;
  cash -= Q + TX_FEE;
  const pos = positions.get(order.mint) ?? { tokens: 0n, cost: 0n };
  pos.tokens += tokens;
  pos.cost += Q + TX_FEE;
  positions.set(order.mint, pos);
  stats.buys += 1;
  mintBuys.set(order.mint, (mintBuys.get(order.mint) ?? 0n) + Q);
  fills.push({ client_id: order.client_id, mint: order.mint, side: 'buy', status: 'filled', reason: null, decided_slot: decidedSlot, slot: order._slot, quote_lamports: Q.toString(), token_amount: tokens.toString(), fee_lamports: fee.toString(), tx_fee_lamports: TX_FEE.toString(), fee_fallback: false });
}

function doSell(order, decidedSlot, fills, harnessClose = false) {
  const c = curves.get(order.mint);
  const T = BigInt(order.token_amount);
  const fail = (m) => {
    stats.rejected += 1;
    stats.rejectReasons[m] = (stats.rejectReasons[m] ?? 0) + 1;
    fills.push({ client_id: order.client_id, mint: order.mint, side: 'sell', status: 'rejected', reason: m, decided_slot: decidedSlot, slot: order._slot, quote_lamports: '0', token_amount: '0', fee_lamports: '0', tx_fee_lamports: '0', fee_fallback: false });
  };
  const pos = positions.get(order.mint);
  if (!c || !pos || pos.tokens < T) return fail('insufficient_tokens');
  if (T === 0n) return fail('zero_amount');
  if (!harnessClose && fnv(order.client_id + SEED) < 2) {
    stats.failed += 1;
    cash -= TX_FEE;
    fills.push({ client_id: order.client_id, mint: order.mint, side: 'sell', status: 'failed', reason: null, decided_slot: decidedSlot, slot: order._slot, quote_lamports: '0', token_amount: '0', fee_lamports: '0', tx_fee_lamports: TX_FEE.toString(), fee_fallback: false });
    return;
  }
  const gross = (c.vQ * T) / (c.vT + T);
  const fee = (gross * CURVE_FEE_BPS) / BPS;
  const received = gross - fee;
  if (!harnessClose) {
    const expGross = (order.vQd * T) / (order.vTd + T);
    const expFee = (expGross * CURVE_FEE_BPS) / BPS;
    const expReceived = expGross - expFee;
    if (received < (expReceived * BigInt(10_000 - order.max_slippage_bps)) / 10_000n) return fail('max_slippage');
  }
  c.vT += T;
  c.vQ -= gross;
  c.rT += T;
  c.rQ -= gross;
  const costOut = (pos.cost * T) / pos.tokens; // pro-rata cost of the tokens sold
  const pnl = received - TX_FEE - costOut;
  if (pnl > 0n) { stats.wins += 1; stats.winLamports += pnl; }
  else { stats.losses += 1; stats.lossLamports += -pnl; }
  cash += received - TX_FEE;
  pos.tokens -= T;
  pos.cost -= costOut;
  if (pos.tokens === 0n) positions.delete(order.mint);
  stats.sells += 1;
  mintSold.add(order.mint);
  fills.push({ client_id: order.client_id, mint: order.mint, side: 'sell', status: 'filled', reason: null, decided_slot: decidedSlot, slot: order._slot, quote_lamports: received.toString(), token_amount: T.toString(), fee_lamports: fee.toString(), tx_fee_lamports: TX_FEE.toString(), fee_fallback: false });
}

// --- main loop: batches grouped by slot ------------------------------------
let i = 0;
while (i < events.length && events[i]._t < windowStart) i++;
const windowEvents = [];
while (i < events.length && events[i]._t < windowEnd) { windowEvents.push(events[i]); i++; }

let idx = 0;
while (idx < windowEvents.length) {
  const slot = windowEvents[idx].slot;
  const batchEvents = [];
  let t = 0;
  while (idx < windowEvents.length && windowEvents[idx].slot === slot) {
    batchEvents.push(windowEvents[idx]);
    t = Math.max(t, windowEvents[idx]._t);
    idx += 1;
  }
  // (a) apply events to sim curves
  const completedMints = [];
  for (const e of batchEvents) {
    applyEventToCurve(e);
    if (e.event === 'CompleteEvent') completedMints.push(e.mint);
  }
  // (b) fills resolving this slot
  const fills = [];
  for (const m of completedMints) {
    const pos = positions.get(m);
    if (pos && pos.tokens > 0n) {
      completeSeq += 1;
      completeCloses += 1;
      doSell({ client_id: `_complete_${completeSeq}`, mint: m, token_amount: pos.tokens.toString(), max_slippage_bps: 10_000, _slot: slot }, slot, fills, true);
    }
  }
  const due = pending.filter((p) => p.decidedSlot + latencyN <= slot);
  for (const p of due) {
    p.order._slot = slot;
    p.order.vTd = p.vTd;
    p.order.vQd = p.vQd;
    if (p.order.side === 'buy') doBuy(p.order, p.decidedSlot, fills);
    else doSell(p.order, p.decidedSlot, fills);
  }
  for (const p of due) pending.splice(pending.indexOf(p), 1);
  // (c) build the batch the bot sees
  const heldMints = new Set([...positions.keys(), ...pending.map((p) => p.order.mint)]);
  const marks = [];
  for (const m of heldMints) {
    const c = curves.get(m);
    if (!c) continue;
    marks.push({ mint: m, slot, virtual_token_reserves: c.vT.toString(), virtual_quote_reserves: c.vQ.toString(), real_token_reserves: c.rT.toString(), real_quote_reserves: c.rQ.toString() });
  }
  const account = {
    cash_lamports: cash.toString(),
    positions: [...positions.entries()].map(([mint, p]) => ({ mint, token_amount: p.tokens.toString(), cost_lamports: p.cost.toString() })),
  };
  const batch = { type: 'batch', seq, slot, events: batchEvents, marks, fills, account };
  seq += 1;
  // (d) drive the bot
  state.applyBatch(batch);
  const orders = onBatch(state, batch);
  const validated = state.toOrders(orders); // throws OrderError on protocol violation
  state.recordOrders(validated);
  for (const o of validated) {
    const c = curves.get(o.mint);
    pending.push({ order: o, decidedSlot: slot, vTd: c ? c.vT : 0n, vQd: c ? c.vQ : 0n, seq });
  }
  equitySeries.push([t, equityNow()]);
}

// --- flatten at window end --------------------------------------------------
for (const [mint, pos] of [...positions.entries()]) {
  const fills = [];
  doSell({ client_id: `_flatten_1`, mint, token_amount: pos.tokens.toString(), max_slippage_bps: 10_000, _slot: 0 }, 0, fills, true);
}
const finalEquity = equityNow();
const netPnl = finalEquity - 10_000_000_000;

// --- metrics ----------------------------------------------------------------
let peak = -Infinity;
let maxDd = 0;
for (const [, eq] of equitySeries) {
  if (eq > peak) peak = eq;
  if (peak > 0) maxDd = Math.max(maxDd, (peak - eq) / peak);
}
equitySeries.push([windowEnd, finalEquity]);
// hourly log returns
const hourly = [];
for (let h = 1; h <= hoursN; h++) {
  const boundary = windowStart + h * 3600;
  let prev = null;
  let cur = null;
  for (const [t, eq] of equitySeries) {
    if (t <= windowStart + (h - 1) * 3600) prev = eq;
    if (t <= boundary) cur = eq;
  }
  if (prev !== null && cur !== null && prev > 0 && cur > 0) hourly.push(Math.log(cur / prev));
}
const mean = hourly.length ? hourly.reduce((a, b) => a + b, 0) / hourly.length : 0;
const variance = hourly.length > 1 ? hourly.reduce((a, b) => a + (b - mean) ** 2, 0) / (hourly.length - 1) : 0;
const std = Math.sqrt(variance);
const sharpe = std > 0 ? mean / std : 0;

let distinct = 0;
for (const [mint, bought] of mintBuys) {
  if (bought >= 10_000_000n && mintSold.has(mint)) distinct += 1;
}
const roundTrips = stats.wins + stats.losses;

console.log(JSON.stringify({
  window: `startHour=${startHourN} hours=${hoursN}`,
  params: { stakeSol: stakeSolN, tpBps: tpBpsN, slBps: slBpsN, riseBps: riseBpsN, mode, smoothDipBps: smoothDipBpsN, buyFlowBps: buyFlowBpsN },
  netPnlLamports: netPnl,
  netPnlSol: netPnl / 1e9,
  hourlySharpe: Number(sharpe.toFixed(6)),
  hourlySharpeAnnualized: Number((sharpe * Math.sqrt(8760)).toFixed(4)),
  hourlyReturns: hourly.map((r) => Number(r.toFixed(6))),
  maxDrawdown: Number(maxDd.toFixed(6)),
  distinctMintsRoundTrips: distinct,
  guardrails: { minDistinct20: distinct >= 20, maxDrawdown50: maxDd <= 0.5, netPnlPositive: netPnl > 0 },
  fills: { buys: stats.buys, sells: stats.sells, roundTrips, wins: stats.wins, losses: stats.losses, winRate: roundTrips ? Number((stats.wins / roundTrips).toFixed(4)) : 0, rejected: stats.rejected, rejectReasons: stats.rejectReasons, failed: stats.failed, completeCloses },
  exits: debug.exits,
  entries: debug.entries,
  avgWinSol: stats.wins ? Number(stats.winLamports / BigInt(stats.wins)) / 1e9 : 0,
  avgLossSol: stats.losses ? Number(stats.lossLamports / BigInt(stats.losses)) / 1e9 : 0,
  finalEquitySol: finalEquity / 1e9,
}, null, 2));
