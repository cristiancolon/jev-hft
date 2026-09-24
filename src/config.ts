import type { Encoding } from './market/encode.ts';
import type { FeedConfig } from './news/rss.ts';

/** Numeric env var: unset or empty means the default; anything non-numeric is an error. */
export const envNum = (name: string, fallback: number, { min = -Infinity } = {}) => {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  if (Number.isNaN(n) || n < min) throw new Error(`${name} must be a number >= ${min}, got "${v}"`);
  return n;
};

/** Env var that must be one of a few words. */
function envChoice<T extends string>(name: string, fallback: T, allowed: readonly T[]): T {
  const v = process.env[name] || fallback;
  if (!allowed.includes(v as T)) throw new Error(`${name} must be one of ${allowed.join(', ')}, got "${v}"`);
  return v as T;
}

/**
 * Public feeds polled by default, with the instruments their news is about and how the source
 * is described to the model. Fed releases are macro news, so they are routed to the broad US
 * market (SPY) as well as Bitcoin.
 * Override with NEWS_FEEDS="name=url name=url ..." (custom feeds route to Bitcoin).
 */
export const DEFAULT_FEEDS: FeedConfig[] = [
  { name: 'fed', label: 'Federal Reserve press releases (official)', url: 'https://www.federalreserve.gov/feeds/press_all.xml', symbols: ['SPY', 'BTC-USD'] },
  { name: 'cftc', label: 'CFTC press releases (official)', url: 'https://www.cftc.gov/RSS/RSSGP/rssgp.xml', symbols: ['BTC-USD'] },
  { name: 'coinbase-status', label: 'Coinbase status page (official)', url: 'https://status.coinbase.com/history.atom', symbols: ['BTC-USD'] },
  { name: 'coindesk', label: 'CoinDesk (crypto news site)', url: 'https://www.coindesk.com/arc/outboundfeeds/rss', symbols: ['BTC-USD'] },
  { name: 'cointelegraph', label: 'Cointelegraph (crypto news site)', url: 'https://cointelegraph.com/rss', symbols: ['BTC-USD'] },
];

function feeds(spec: string | undefined): FeedConfig[] {
  if (!spec) return DEFAULT_FEEDS;
  return spec
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(pair => {
      const eq = pair.indexOf('=');
      if (eq < 1) throw new Error(`NEWS_FEEDS entries must be name=url, got "${pair}"`);
      return { name: pair.slice(0, eq), url: pair.slice(eq + 1), symbols: ['BTC-USD'] };
    });
}

const NEWS_SOURCES = ['rss', 'alpaca', 'edgar', 'x'] as const;

/** NEWS_SOURCES=none runs no live source at all (useful with NEWS_MANUAL=1). */
function sources(spec: string | undefined): string[] {
  if (spec?.trim() === 'none') return [];
  const list = (spec || NEWS_SOURCES.join(',')).split(',').map(s => s.trim()).filter(Boolean);
  const unknown = list.filter(s => !(NEWS_SOURCES as readonly string[]).includes(s));
  if (unknown.length > 0) throw new Error(`NEWS_SOURCES has unknown entries: ${unknown.join(', ')} (choose from ${NEWS_SOURCES.join(', ')})`);
  return list;
}

/**
 * The fee per fill. FEE_BPS, the setting this replaced, was for a whole round trip; an old .env
 * that still sets it keeps the same cost, read as half on each side. FEE_BPS_PER_SIDE wins if
 * both are set.
 */
function feeBpsPerSide() {
  const legacy = process.env.FEE_BPS?.trim();
  if (process.env.FEE_BPS_PER_SIDE?.trim() || !legacy) return envNum('FEE_BPS_PER_SIDE', 5, { min: 0 });
  return envNum('FEE_BPS', 0, { min: 0 }) / 2;
}

/** Binance.US pair names, like BTCUSD. Each goes into a web address and a file name, so only letters and digits. */
function binanceUsSymbols(spec: string | undefined): string[] {
  const list = (spec || 'BTCUSD,BTCUSDT').split(/[\s,]+/).filter(Boolean).map(s => s.toUpperCase());
  const bad = list.filter(s => !/^[A-Z0-9]{5,20}$/.test(s));
  if (bad.length > 0 || list.length === 0) throw new Error(`BINANCEUS_SYMBOLS must be Binance.US pair names like BTCUSD,BTCUSDT, got "${spec}"`);
  return [...new Set(list)];
}

const alpacaFeed = process.env.ALPACA_FEED || 'iex';

/** Official accounts followed on X by default: US economic agencies and market regulators, and Coinbase. */
export const DEFAULT_X_ACCOUNTS = ['federalreserve', 'SECGov', 'CFTC', 'USTreasury', 'BLS_gov', 'coinbase'];

export const config = {
  product: process.env.PRODUCT || 'BTC-USD',
  /**
   * Binance.US pairs `npm run record:binanceus` saves, one file each. BTC/USDT trades the most
   * there and BTC/USD compares directly with Coinbase's BTC-USD; both are small (about $3M and
   * $1M a day in September 2026).
   */
  binanceUsSymbols: binanceUsSymbols(process.env.BINANCEUS_SYMBOLS),
  /** Save the raw market events as well, so a live run can be replayed later (RECORD=1). */
  record: process.env.RECORD === '1',
  /** Which route to Jev: typesafe (direct, the fastest), gateway, or mock (src/model/jev.ts). */
  provider: process.env.JEV_PROVIDER || 'typesafe',
  encoding: envChoice<Encoding>('JEV_ENCODING', 'compact', ['compact', 'json']),
  /**
   * Minimum spacing between market-data decisions. Asking back to back (0) gives about 2.7
   * decisions a second, but the report counts stretches of time, not decisions, so that mostly
   * buys the same information several times over. One a second costs about a third as much.
   */
  minIntervalMs: envNum('JEV_MIN_INTERVAL_MS', 1000, { min: 0 }),
  /** Concurrent model calls. >1 raises decision rate, not decision freshness. */
  maxInFlight: envNum('JEV_MAX_INFLIGHT', 1, { min: 1 }),
  /** Abandon a call after this long; its answer would be too stale to act on. */
  timeoutMs: envNum('JEV_TIMEOUT_MS', 2000, { min: 100 }),
  /**
   * "Flat" means a move smaller than this many typical moves for the horizon; 0 = fixed thresholds.
   * Backtests of 0.5, 1, and 2 on the same snapshots predicted equally well; 2 left the fewest of
   * Jev's answers stuck at the extremes (docs/model.md).
   */
  flatSigmas: envNum('JEV_FLAT_SIGMAS', 2, { min: 0 }),
  /** Let returns, volatility, and z-score windows fill before deciding. */
  warmupMs: envNum('WARMUP_S', 60, { min: 0 }) * 1000,
  runMs: envNum('RUN_MINUTES', 0, { min: 0 }) * 60_000,
  /** Forward-return horizons (seconds) recorded for every decision. */
  horizons: [1, 2, 5, 10, 30, 60],
  /**
   * What the exchange charges per fill, in bps, the way fee schedules quote it. A round trip pays
   * it twice, plus the spread, and that is charged to every trade in the reports and the
   * dashboard's profit and loss (src/model/costs.ts). The default is Coinbase Advanced Trade's
   * lowest published taker fee (0.05%, its biggest-volume tier), the least a taker pays there;
   * its smallest tier charged 0.60% (60) when this was written. 0 shows what the moves alone
   * were worth.
   */
  feeBpsPerSide: feeBpsPerSide(),

  alpaca: {
    key: process.env.ALPACA_API_KEY_ID || '',
    secret: process.env.ALPACA_API_SECRET_KEY || '',
    /** 'iex' (free plan: one exchange) or 'sip' (paid plan: all US exchanges). */
    feed: alpacaFeed,
    /** Live quote subscriptions at once; the free plan allows 30. */
    maxSymbols: envNum('ALPACA_MAX_SYMBOLS', alpacaFeed === 'iex' ? 30 : 1000, { min: 1 }),
  },

  x: {
    bearer: process.env.X_BEARER_TOKEN || '',
    accounts: (process.env.X_ACCOUNTS || DEFAULT_X_ACCOUNTS.join(' ')).split(/[\s,]+/).filter(Boolean).map(a => a.replace(/^@/, '')),
    /** Seconds between searches. X bills per post read, not per search, so checking often is free. */
    pollMs: envNum('X_POLL_S', 10, { min: 5 }) * 1000,
    /** Posts read per UTC day before the source pauses (X bills per post read). */
    maxPostsPerDay: envNum('X_MAX_POSTS_PER_DAY', 500, { min: 1 }),
  },

  news: {
    /** Which sources to run: rss, alpaca (needs Alpaca keys), edgar (needs NEWS_USER_AGENT), x (needs X_BEARER_TOKEN). */
    sources: sources(process.env.NEWS_SOURCES),
    feeds: feeds(process.env.NEWS_FEEDS),
    /** At most this many instruments per item; items tagged with many tickers are usually roundups. */
    maxSymbolsPerItem: envNum('NEWS_MAX_SYMBOLS', 3, { min: 1 }),
    /** Route for tagged-source items without tickers (macro news): broad market and Bitcoin. */
    untagged: ['SPY', 'BTC-USD'],
    /** Poll interval for feeds that send their whole content on every check. */
    pollMs: envNum('NEWS_POLL_S', 30, { min: 5 }) * 1000,
    /** Poll interval for feeds that can answer "nothing changed" without sending anything. */
    fastPollMs: envNum('NEWS_FAST_POLL_S', 10, { min: 5 }) * 1000,
    userAgent: process.env.NEWS_USER_AGENT || 'jev-research/0.1 (news poller)',
    manual: process.env.NEWS_MANUAL === '1',
    /** Items evaluated at the same time, so a burst of news does not queue behind one call. */
    maxInFlight: envNum('NEWS_MAX_INFLIGHT', 4, { min: 1 }),
    /** News is judged over minutes, so a slow answer is still worth waiting for. */
    timeoutMs: envNum('NEWS_TIMEOUT_MS', 5000, { min: 100 }),
    /** Give up on an item that has waited this long for the model (rate limits, failures). */
    maxAgeMs: envNum('NEWS_MAX_AGE_S', 300, { min: 1 }) * 1000,
    /** Ask only about instruments whose outcome can be measured: market open, usable quote. */
    onlyTradable: process.env.NEWS_ONLY_TRADABLE !== '0',
    /** A stock quote wider than this is not a usable price (engine and report use the same limit). */
    maxSpreadBps: envNum('MAX_SPREAD_BPS', 50, { min: 0 }),
    /** Forward-return horizons (seconds) recorded for each news decision. */
    horizons: [10, 30, 60, 300, 900, 1800],
  },
};
