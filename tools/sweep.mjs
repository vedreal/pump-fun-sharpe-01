// Sweep helper: runs the backtest over a list of configs and prints one line each.
import { execFileSync } from 'node:child_process';

const configs = process.argv.slice(2);
if (configs.length === 0) {
  console.log('usage: node tools/sweep.mjs "start hours stake tp sl rise" ...');
  process.exit(1);
}
for (const cfg of configs) {
  const args = cfg.trim().split(/\s+/);
  const out = execFileSync('node', ['tools/backtest.mjs', ...args], { encoding: 'utf8', maxBuffer: 1 << 24 });
  const d = JSON.parse(out);
  const e = d.exits;
  console.log(
    `cfg=[${cfg}] pnl=${d.netPnlSol >= 0 ? '+' : ''}${d.netPnlSol.toFixed(4)} sharpe=${d.hourlySharpe >= 0 ? '+' : ''}${d.hourlySharpe.toFixed(2)} ` +
    `mints=${d.distinctMintsRoundTrips} wr=${d.fills.winRate.toFixed(2)} avgW=${d.avgWinSol.toFixed(4)} avgL=${d.avgLossSol.toFixed(4)} ` +
    `dd=${d.maxDrawdown.toFixed(3)} rej=${d.fills.rejected} exits tp=${e.tp} sl=${e.sl} tr=${e.trail} tP=${e.timeProfit} tM=${e.timeMax}`,
  );
}
