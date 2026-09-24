# Start here

These docs explain what this project does, how each part works, and **why it was built the
way it is**. They're written so you can read them top to bottom and come away understanding
the whole system, even if you've never looked at the code.

Whenever a design choice rests on a measurement, the number is included along with when and
where it was measured. Treat those numbers as evidence from one setup (a laptop on a US West
Coast home internet connection, September 2026), not as fixed facts. Your numbers will differ
somewhat.

## What this project is

This is a research project, not a trading bot. Nothing in it places real trades.

It tests one idea: **a fast AI model that understands language might be able to make useful
trading judgments quickly enough to matter.** Large AI models such as ChatGPT or Claude can
read and reason, but they take seconds to answer. Jev, a model made by TypeSafe AI, is built
for fast yes/no and multiple-choice style judgments and answers in a fraction of a second. If
that speed plus understanding can predict price moves before the market finishes reacting,
that's an edge.

We reach Jev through **Vercel AI Gateway**, a service that forwards our requests to many AI
models from one account.

The project has two ways of testing the idea:

1. **The market-data path** (`npm run live`, `record`, `backtest`, `analyze`). It watches
   Bitcoin's order book and trades on Coinbase, summarizes what's happening into a short
   paragraph, and asks Jev: "Will the price be higher, lower, or about the same in a few
   seconds?"
2. **The news path** (`npm run news`, `analyze:news`). It collects news as it's published
   (from news feeds, a professional newswire, SEC filings, and official accounts on X) and
   asks Jev, for each item: "Does this matter for Bitcoin or this stock? Which way would it
   push the price? How much? Is it actually new?"

Both paths write down every answer together with what the price did afterwards, so we can
check later whether Jev's judgments were right, and whether they arrived fast enough to act on.

### What we've learned so far

- **Speed:** a Jev answer takes about 130 ms, going straight to TypeSafe. Through Vercel's AI
  Gateway it took about 260 ms; most of that extra was the trip to Cleveland and back rather
  than the model, so the pipeline now calls TypeSafe directly (see [latency.md](latency.md)).
  About 105 ms of what is left is Jev's own thinking, which is the floor for this model.
- **For news, noticing is slower than judging.** Most sources have to be checked on a timer, so
  several seconds pass before we even see an item. Only the newswire is pushed to us.
- **The market-data path has a cost problem:** over seconds, Bitcoin's price barely moves.
  Even a perfect prediction would earn less than the fees to trade on it. That's why the news
  path exists: news can move prices by much more.
- **On market data, Jev doesn't beat a one-line rule.** Over a nine-hour live run (30,312
  decisions), Jev's calls had a real relationship with the next move at 2 and 10 seconds. Simply
  comparing how much is waiting to buy against how much is waiting to sell did better, instantly
  and for free, and once that rule was accounted for almost nothing of Jev's signal was left.
  Its probabilities were also far too confident, and at 60 seconds it showed nothing at all. It
  points the same way as the cost problem: the news path is where Jev's understanding of
  language could matter ([model.md](model.md#what-jev-has-shown-on-market-data-so-far)).
- **Jev leans "down" nearly all the time, so its answers are read against its usual one.** The
  price rose as often as it fell, yet more than 80% of Jev's short-term answers leaned down,
  because things that are one-sided all day read as bearish every second. Read against what it
  has usually been saying, Jev pointed the right way 66% of the time at 2 seconds instead of 59%.
  The fix looks only at Jev's own earlier answers, never at prices, and was checked on hours that
  played no part in choosing it
  ([model.md](model.md#reading-jevs-lean-against-its-usual-one)).
- **Jev understands the news questions:** on test headlines it rated a surprise rate cut as
  very bullish, an exchange shutting withdrawals as very bearish, and a bakery accepting
  Bitcoin as irrelevant. Shown what had already been reported, it correctly marked a reworded
  repeat as not new. Whether its judgments are *profitable* needs real data collected over time.
- **Cost is small:** about three thousandths of a cent per decision. The news path costs cents a
  day; asking about the market once a second costs about $3 a day.

## Reading order

| Document | What you'll learn |
|---|---|
| [architecture.md](architecture.md) | How the pieces fit together and the few rules that hold everything together. Read this first. |
| [latency.md](latency.md) | Where the time goes, measured step by step, what it costs, and why that shaped the design. |
| [news.md](news.md) | The news path in detail: sources, which assets an item is about, what's worth asking, the questions, stock prices. |
| [feed.md](feed.md) | How live market data is collected from Coinbase (Bitcoin) and Alpaca (stocks), and how dead connections are noticed. |
| [market.md](market.md) | How the order book is tracked, what the pipeline measures from it, and how it's summarized for Jev. |
| [model.md](model.md) | How we call Jev, the questions we ask it, and the practice model used for free testing. |
| [engine.md](engine.md) | The live loop of the market-data path and what gets recorded for each decision. |
| [backtest-and-analysis.md](backtest-and-analysis.md) | Recording data, replaying it, and how the reports judge whether Jev is any good. |
| [benchmark.md](benchmark.md) | The tool that measures Jev's response time. |
| [dashboard.md](dashboard.md) | The live dashboard: what it shows, and how it watches the pipeline without slowing it down. |
| [testing.md](testing.md) | What the tests protect, and how the engines are tested without the outside world. |
| [operations.md](operations.md) | Running things, every setting, costs, fixing common problems, running on a Raspberry Pi. |
| [decisions.md](decisions.md) | A numbered log of every major design decision: what we chose, why, and when to rethink it. |
| [handoff-accuracy.md](handoff-accuracy.md) | Where the 10 s / 60 s accuracy work stands: the data, the first findings, and what to try next. |

## Glossary

| Term | Plain meaning |
|---|---|
| **Basis point (bp)** | One hundredth of a percent (0.01%). A 1% move is 100 bp. All price moves and costs in these docs are in bp. |
| **Bid / ask** | The best price someone is willing to pay (bid) and the best price someone is willing to sell at (ask). |
| **Spread** | The gap between the bid and the ask. Crossing it is part of the cost of trading. When it's very wide, the midpoint isn't a real price. |
| **Mid price** | Halfway between the bid and the ask. We use it as "the price" when measuring moves. |
| **Order book** | The full list of buy and sell offers waiting at each price level. |
| **Tick** | The smallest price step allowed. For Bitcoin on Coinbase it's $0.01, tiny compared to its ~$81,000 price. |
| **Taker / aggressor** | The trader who accepts an existing offer and makes a trade happen immediately (as opposed to the one who was waiting). |
| **Volatility** | How much the price is jumping around. Here: the typical size of a one-second price change over the last minute. |
| **Latency** | Delay: how long something takes. Usually in milliseconds (ms): 1,000 ms = 1 second. |
| **Median (p50) / 90th percentile (p90)** | The typical case (half of samples are faster) and a slow case (only 10% are slower). |
| **API** | A service built for programs to talk to. We use the official APIs of Coinbase, Alpaca, X, the SEC, and Vercel. |
| **WebSocket** | A connection that stays open so a service can push updates to us the moment they happen, instead of us asking repeatedly. |
| **Polling** | Asking a service "anything new?" on a timer. Simpler than a WebSocket but slower to notice news. |
| **Heartbeat** | A small regular message whose only job is to prove a connection is still alive. |
| **Telemetry** | Messages a program sends out about what it's doing, for something else to display. Here: what the pipeline tells the dashboard. |
| **UDP** | A way of sending a message over a network with no connection and no confirmation that it arrived. Useless for anything that matters, ideal for "tell whoever is watching, and never wait". |
| **Rate limit** | A cap on how many requests a service accepts per period. Going over returns error 429 ("too many requests"). |
| **Token** | The unit AI models count text in (roughly ¾ of a word). Jev charges by input tokens. |
| **State** | The text we give Jev to judge: a summary of the market, or a headline plus context. |
| **Question** | What we ask Jev about a state. Three kinds: **choice** (pick one option), **score** (rate on a scale), and **yes/no** (TypeSafe calls this "noul"). Jev answers each with probabilities. |
| **Confidence** | A number from 0 to 1 that TypeSafe returns with each choice or score answer, saying how sure Jev was. |
| **Decision** | One call to Jev and everything we record about it. |
| **Horizon** | How far ahead we check the price after a decision, e.g. 10 seconds or 30 minutes. |
| **Signal** | A number that says "up" (positive) or "down" (negative) and how strongly. |
| **Baseline** | A simple rule, such as "more buyers than sellers waiting means up next", that Jev has to beat to be worth anything. |
| **Information coefficient (IC)** | A score from −1 to +1 for how well a signal ranked outcomes: +1 means its strongest "up" calls always saw the biggest rises, 0 means no relationship. |
| **Calibration** | Whether probabilities mean what they say: of all the times Jev says 70%, does it happen about 70% of the time? |
| **Backtest** | Running the decision process on recorded past data to see how it would have done. |
| **Paper trading** | Recording what we *would* have done, without real money. |
| **Instrument** | Something we can price a news item against: Bitcoin (`BTC-USD`) or a US stock ticker like `AAPL`. |
| **Session** | For US stocks: `pre` (4:00–9:30 ET), `regular` (9:30–16:00), `post` (16:00–20:00), or `closed`. Bitcoin trades `24/7`. |
| **IEX / SIP** | Two kinds of US stock price data from Alpaca. IEX (free) covers one exchange; SIP (paid) combines all exchanges. We use IEX. |
| **8-K** | The report a US company must file with the SEC when something significant happens. |
| **Gateway** | Vercel AI Gateway, our default route to Jev. |
| **Mock model** | A stand-in for Jev that gives random answers after a realistic delay, so everything can be tested for free. |

## Map of the code

```
src/
  config.ts             every setting, read from environment variables and checked; default news feeds and X accounts
  feed/types.ts         the common format for market data (MarketEvent) and the pipeline's clock
  feed/coinbase.ts      live Bitcoin order book and trades from Coinbase
  feed/alpaca.ts        shared connection code for Alpaca (sign in, heartbeat, reconnect, resubscribe)
  feed/alpaca-stocks.ts live US stock prices from Alpaca, switched on only for stocks in the news
  feed/recorder.ts      saves market events to a compressed file for later replay
  market/book.ts        the order book (every price level, kept sorted)
  market/state.ts       everything we know about the Bitcoin market right now, plus recent history
  market/encode.ts      turns the market measurements into the short text Jev reads
  market/replay.ts      feeds a recording through the market state without ever looking ahead
  market/quotes.ts      price and spread history for each stock
  market/prices.ts      one way to ask "what did this cost at time t?" for Bitcoin and stocks alike
  market/sessions.ts    US market hours, in New York time
  model/jev.ts          how we call Jev (either route), its connection, the market-data questions, and the mock model
  model/lean.ts         reading Jev's lean against what it usually says, which is what gets acted on
  engine.ts             the live loop of the market-data path and its record format
  live.ts               runs the market-data path live
  record.ts             saves the Coinbase feed to disk (live.ts can do this too, with RECORD=1)
  backtest.ts           replays saved data through the same code, paying for each answer once
  analyze.ts            report for the market-data path
  news/types.ts         the common format for news items
  news/rss.ts           reads public news feeds (RSS/Atom)
  news/alpaca.ts        reads the Benzinga newswire through Alpaca
  news/edgar.ts         reads new SEC 8-K filings and restates them in plain words
  news/tickers.ts       the SEC's company list: company numbers to tickers, tickers to names
  news/x.ts             reads posts from chosen official X accounts
  news/manual.ts        lets you type test headlines
  news/instruments.ts   decides which assets an item is about, and how to name them to Jev
  news/memory.ts        remembers recent headlines: spots repeats, supplies "already reported" context
  news/questions.ts     the questions Jev is asked about news, and what it's shown
  news/moves.ts         when a price move after a news decision counts (shared by the report and the dashboard)
  news/engine.ts        the news loop (what's worth asking, retries) and its record format
  news-live.ts          runs the news path live
  analyze-news.ts       report for the news path
  lib/stats.ts          small math helpers (percentiles, rank correlation, safe number handling)
  lib/poll.ts           repeats a task politely on a timer, backing off after failures
  lib/backoff.ts        the pause that grows after each rate-limit refusal
  lib/seen.ts           remembers which items a source has already reported
  lib/run.ts            start and stop handling shared by the long-running programs
  telemetry/events.ts   every message the pipeline sends the dashboard
  telemetry/sender.ts   sends them without ever making the pipeline wait
  dashboard.ts          `npm run dashboard`: starts the dashboard server
  dashboard/server.ts   the dashboard program: listens to the pipeline, reads its results, serves the page
  dashboard/collector.ts  what the dashboard knows and how each message changes it (runs in the server AND the browser)
  dashboard/outcomes.ts scores finished decisions: what happened next, Jev against the simple rules
  dashboard/web/        the page itself: TypeScript, hand-drawn charts, no framework and no build step
test/                   the tests, and stand-ins for the model, prices, and clock (see testing.md)
bench/latency.ts        measures Jev's response time on either route, side by side
examples/triage.ts      the smallest possible Jev example
deploy/pi/              Raspberry Pi setup script and background service (see deploy/pi/README.md)
.github/workflows/      runs the type check and the tests on GitHub after every push
```
