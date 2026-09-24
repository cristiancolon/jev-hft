// Record Binance.US's order book and trades, one file per pair, in the same standard form as the
// Coinbase recording (`npm run record`), so the two can be replayed side by side.
//
//   npm run record:binanceus                              # BTCUSD and BTCUSDT (BINANCEUS_SYMBOLS)
//   BINANCEUS_SYMBOLS=BTCUSD RUN_MINUTES=10 npm run record:binanceus
//
// Why a separate program: the Coinbase recorder has been running for days, and one exchange's
// trouble should never stop the other's recording. Each pair also gets its own connection, so a
// broken book on one never resets the other.

import { config } from './config.ts';
import { binanceUsFeed } from './feed/binanceus.ts';
import { recorder } from './feed/recorder.ts';
import { log, onStop } from './lib/run.ts';

const runs = config.binanceUsSymbols.map(symbol => {
  const rec = recorder(`binanceus-${symbol}`);
  const feed = binanceUsFeed(symbol, e => rec.write(e), log);
  log(`recording Binance.US ${symbol} -> ${rec.file}`);
  return { symbol, rec, feed };
});
const status = setInterval(() => log(runs.map(r => `${r.symbol} ${r.rec.events} events`).join('  ')), 30_000);

onStop(() => {
  clearInterval(status);
  for (const r of runs) r.feed.close();
  void Promise.all(runs.map(r => r.rec.close())).then(() => {
    for (const r of runs) log(`wrote ${r.rec.events} events to ${r.rec.file}`);
    process.exit(0);
  });
}, config.runMs);
