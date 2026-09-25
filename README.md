# jev-hft

A research project that tests whether **Jev**, a fast AI model from TypeSafe AI, can judge
market data and news quickly and accurately enough to matter for trading. Jev is reached
through **Vercel AI Gateway**.

It only paper-trades: it records what it would decide and what prices did next. It never
places real trades, and nothing here is investment advice.

## What it does

There are two parts, and each can be run on its own:

- **The news part** (`npm run news`) collects news as it's published, from public news feeds,
  the Benzinga newswire (through Alpaca), new SEC filings, and a few official X accounts. For
  each item it works out which assets it's about (Bitcoin, a US stock, or the market as a whole),
  checks that the outcome could actually be measured, and asks Jev: is this relevant, which way
  would it push the price, how big a move, and is it actually new? Then it records what the
  prices did over the next 30 minutes.
- **The market-data part** (`npm run live`) watches Bitcoin's order book and trades on Coinbase,
  and once a second records what a small model of the order book expects the price to do over the
  next 10 and 60 seconds. It used to ask Jev as well, in a few lines of text, whether the price
  would be higher, lower, or about the same in 2, 10, and 60 seconds; five days showed Jev added
  nothing there, so that is now off unless `JEV_MARKET=1` ([decisions.md](docs/decisions.md) D63).

Reports (`npm run analyze:news`, `npm run analyze`) then check how often Jev was right, whether
its answers came fast enough to act on, and what they cost.

A **live dashboard** (`npm run dashboard`, then <http://localhost:4000>) shows all of it as it
happens: the price with Jev's calls marked on it, each answer and what Jev was shown, response
times, headlines and what Jev made of them, and a running score of Jev against simple rules. It's
a separate program that the pipeline never waits for, so watching costs the pipeline nothing.

## What we've found so far

- **Speed:** Jev answers in about 130 ms, going straight to TypeSafe. Through Vercel's AI
  Gateway it was about 260 ms: most of the difference was geography, not thinking, so the
  gateway hop was dropped.
- **The market-data part has a cost problem:** over a few seconds Bitcoin barely moves, so even
  perfect predictions would earn less than trading fees. That's why the news part exists.
- **On market data, Jev doesn't beat a one-line rule:** over a nine-hour live run its calls had a
  real relationship with the next move, but plain order-book imbalance did better for free, and
  Jev added almost nothing beyond it. That points the same way as the cost problem.
- **Jev leans "down" nearly all the time, and the pipeline corrects for it:** the price rose as
  often as it fell, yet more than 80% of Jev's short-term answers leaned down. Read against what
  it has usually been saying, it pointed the right way 66% of the time at 2 seconds instead of
  59%, on hours that played no part in choosing the fix
  ([docs/model.md](docs/model.md#reading-jevs-lean-against-its-usual-one)).
- **Jev understands the news questions:** on test headlines it called a surprise rate cut
  bullish, an exchange halting withdrawals bearish, a bakery story irrelevant, and a reworded
  repeat "not new". Whether that makes money needs real data collected over time.

## Getting started

You need **Node.js 24**.

```bash
npm install
cp .env.example .env && chmod 600 .env   # then fill in your keys
npm run check                            # type check and tests; needs no keys
```

Keys go in `.env`, which is private and never committed. Every npm script loads it for you.

| Key | Needed for |
|---|---|
| `AI_GATEWAY_API_KEY` | reaching Jev through Vercel AI Gateway |
| `ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY` | US stock prices and the Benzinga news stream (free Alpaca account) |
| `X_BEARER_TOKEN` | reading posts from X's official API (paid per post) |
| `NEWS_USER_AGENT` | your name and email, which the SEC requires for its filing feed and company list |

To run it around the clock on a Raspberry Pi, see [deploy/pi/README.md](deploy/pi/README.md):
one script sets everything up as a background service.

Any source whose key is missing is simply skipped. To try everything without spending anything,
use the practice model, which gives random answers:

```bash
JEV_PROVIDER=mock NEWS_MANUAL=1 NEWS_SOURCES=none npm run news   # type headlines like "$BTC ETF approved"
```

(On a weekend, add `NEWS_ONLY_TRADABLE=0` to try stock headlines such as `$AAPL beats earnings`;
normally stocks aren't asked about while their market is closed.)

## Commands

```bash
npm run news                              # the news part, live
npm run live                              # the market-data part, live (JEV_MARKET=1 asks Jev too)
npm run record                            # save Coinbase market data to disk
npm run backtest -- data/raw/<file>       # replay saved data and ask Jev about it
npm run analyze:news -- data/decisions/news-<file>.jsonl
npm run analyze -- data/decisions/<file>.jsonl
npm run dashboard                         # watch it all live at http://localhost:4000
npm run bench                             # measure Jev's response time
npm run check                             # type check and tests
```

## Costs and limits to know about

- **Jev** costs $0.042 per million input tokens, about three thousandths of a cent per decision.
  The news part costs cents a day; the market-data part about $3 a day. Every status line and
  report shows what a run actually cost.
- **Vercel AI Gateway without credits:** about 5 Jev calls every 5 minutes. That's enough for the
  quieter news sources, but not for the busy Benzinga stream during market hours or the
  market-data part. With credits on the account we saw no limit.
- **Alpaca free plan:** stock prices from one exchange, for up to 30 stocks at a time, and they
  can be unreliable outside trading hours. The pipeline handles both.
- **X:** each post read costs $0.005; searches that find nothing are free. A daily cap (default
  500 posts, at most $2.50) keeps costs down; with the default accounts it's usually cents a day.

## Learn more

The [docs](docs/README.md) explain how every part works and why it's built the way it is, in
plain language. Good places to start:

- [How it all fits together](docs/architecture.md)
- [Where the time goes, and what it costs](docs/latency.md)
- [The news path](docs/news.md)
- [The live dashboard](docs/dashboard.md)
- [Running it, settings, and a Raspberry Pi guide](docs/operations.md)
- [Design decisions](docs/decisions.md)
