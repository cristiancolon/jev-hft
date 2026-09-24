# Running and maintaining it

## Commands

| Command | What it does | Where results go |
|---|---|---|
| `npm run news` | the news path, for Bitcoin and US stocks | `data/decisions/news-...jsonl` and `data/news/items-...jsonl` |
| `npm run live` | the market-data path, live | `data/decisions/live-...jsonl` |
| `npm run record` | saves Coinbase market data | `data/raw/BTC-USD-...jsonl.gz` |
| `RECORD=1 npm run live` | the market-data path live, saving the data as well | both of the above |
| `npm run backtest -- <file>` | replays saved data and asks Jev about it | `data/decisions/backtest-...jsonl` |
| `npm run analyze -- <files>` | report for the market-data path | printed |
| `npm run analyze:news -- <files>` | report for the news path | printed |
| `npm run dashboard` | the live dashboard, at <http://localhost:4000> | a web page; it saves nothing |
| `npm run bench` | measures Jev's response time | printed |
| `npm run example` | the smallest possible Jev call | printed |
| `npm test` | runs the tests (about a second, no network or keys needed) | printed |
| `npm run check` | type check, then the tests | printed |
| `node research/extract.ts <recording>` | one row of order-book measurements a second, for refitting the order-book model ([accuracy.md](accuracy.md#refitting)) | `data/research/rows.f64` and `.json` |
| `python3 research/fit.py data/research/rows` | fits and tests the 10 s and 60 s models, day by day; `--final --export src/model/weights` scores the locked day and writes new weights | printed |

Every runner stops cleanly with Ctrl-C, when the system shuts it down, or after `RUN_MINUTES`.
Try anything new with `JEV_PROVIDER=mock` first: it's free and has no rate limits.

## Setup

1. Install **Node.js 24**.
2. Run `npm install` in the project folder.
3. Copy `.env.example` to `.env`, fill in your keys, and make it private: `chmod 600 .env`.

Every npm script loads `.env` automatically. If a setting is also defined in your shell, the
shell's value wins. On the development Mac, `~/.zshrc` also sets `AI_GATEWAY_API_KEY` (from the
macOS Keychain, via Vercel's setup), so if you ever replace that key, update it in both places.

## Settings

Everything is read in `src/config.ts`. A blank value means "use the default". Settings are
checked at startup, and an invalid one (like `STEP_S=abc`, or a misspelled news source) stops the
program with a clear message.

**Keys and accounts**

| Setting | What it's for |
|---|---|
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway key (needed to reach Jev) |
| `ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY` | Alpaca keys: stock prices and the Benzinga news stream |
| `X_BEARER_TOKEN` | X API read-only key |
| `NEWS_USER_AGENT` | your name and email, required by the SEC for its filing feed and company list |
| `TYPESAFE_AI_API_KEY` | the key for the default route, straight to TypeSafe |

**General**

| Setting | Default | Meaning |
|---|---|---|
| `JEV_PROVIDER` | `typesafe` | `typesafe` (straight to TypeSafe, half the delay), `gateway`, or `mock` (free random answers) |
| `AI_GATEWAY_MODEL` | `typesafe-ai/jev` | the model's name on the gateway, for `JEV_PROVIDER=gateway` |
| `JEV_USD_PER_MTOK` | `0.042` | list price per million input tokens, used to work out what a call cost when the route doesn't say. The gateway reports its own figure and ignores this |
| `MOCK_LATENCY_MS` | `375` | how long the mock takes to answer |
| `RUN_MINUTES` | `0` | stop after this many minutes (0 means run until stopped) |
| `FEE_BPS_PER_SIDE` | `5` | the exchange's fee on each fill, in bp, as its fee schedule quotes it (0.60% is 60). Every trade in the reports and the dashboard's profit and loss pays it twice, plus the spread. 5 is Coinbase's lowest published taker fee; 0 shows what the moves alone were worth. The old `FEE_BPS` (a round-trip figure) still works, read as half on each side |
| `PNL_NOTIONAL_USD` | `10000` | the stake behind each trade in the dashboard's profit and loss |

**Dashboard** ([dashboard.md](dashboard.md))

| Setting | Default | Meaning |
|---|---|---|
| `TELEMETRY` | `1` | where `live` and `news` send their one-way messages for the dashboard. `1` is this machine; `0` or `off` sends nothing; `host` or `host:port` sends them to another machine |
| `DASHBOARD_PORT` | `4000` | the page's port |
| `TELEMETRY_PORT` | `4100` | the port the dashboard listens on for those messages |
| `DASHBOARD_HOST` | `127.0.0.1` | `0.0.0.0` makes the page reachable from other machines on your network. It has no password |

**News path**

| Setting | Default | Meaning |
|---|---|---|
| `NEWS_SOURCES` | `rss,alpaca,edgar,x` | which sources to run; each is skipped with a message if its key is missing. `none` runs no live source (handy with `NEWS_MANUAL=1`) |
| `NEWS_FEEDS` | 5 public feeds | your own list of feeds, as `name=url` pairs (custom feeds count as Bitcoin news) |
| `NEWS_POLL_S` | `30` | seconds between checks of a feed that sends its whole content every time (minimum 5) |
| `NEWS_FAST_POLL_S` | `10` | seconds between checks of a feed that can answer "nothing changed", and of SEC filings (minimum 5) |
| `NEWS_MANUAL` | off | `1` lets you type headlines for testing (`$AAPL`, `$BTC` pick the asset) |
| `NEWS_ONLY_TRADABLE` | `1` | ask Jev only about assets whose outcome can be measured (market open, usable price). `0` asks about everything |
| `MAX_SPREAD_BPS` | `50` | a stock quote wider than this isn't a usable price. Used by the engine (whether to ask) and the report (whether to count a move) |
| `NEWS_MAX_SYMBOLS` | `3` | most assets per news item |
| `NEWS_MAX_INFLIGHT` | `4` | news items judged at the same time |
| `NEWS_TIMEOUT_MS` | `5000` | give up on a news answer slower than this (it's then tried again) |
| `NEWS_MAX_AGE_S` | `300` | drop items that have waited this long for Jev |
| `ALPACA_FEED` | `iex` | `iex` is the free plan; `sip` needs Alpaca's paid plan |
| `ALPACA_MAX_SYMBOLS` | `30` | stocks watched at once (the free plan's limit) |
| `X_ACCOUNTS` | 6 official accounts | X accounts to follow, separated by spaces or commas |
| `X_POLL_S` | `10` | seconds between X searches (a search that finds nothing is free) |
| `X_MAX_POSTS_PER_DAY` | `500` | X posts read per day before pausing (each costs $0.005) |
| `RELEVANT_P` | `0.5` | how sure Jev must be for the report to count an item as relevant |
| `SHOW` | `25` | how many items the news report lists |

**Market-data path**

| Setting | Default | Meaning |
|---|---|---|
| `PRODUCT` | `BTC-USD` | Coinbase product to watch |
| `JEV_ENCODING` | `compact` | `compact` (labeled lines) or `json` |
| `JEV_MIN_INTERVAL_MS` | `1000` | minimum time between questions. `0` asks back to back, about 2.7 a second, for about three times the cost |
| `RECORD` | `0` | `1` makes `npm run live` save the market data it sees as well, so that exact run can be replayed later |
| `JEV_MAX_INFLIGHT` | `1` | questions to Jev at the same time |
| `JEV_TIMEOUT_MS` | `2000` | give up on answers slower than this |
| `JEV_FLAT_SIGMAS` | `2` | what "flat" means in Jev's questions: a move smaller than this many typical moves for the horizon. `0` uses fixed thresholds (0.5, 1, and 3 bp) |
| `WARMUP_S` | `60` | history to collect before asking Jev |
| `STEP_S`, `BT_LATENCY_MS`, `BT_CONCURRENCY`, `BT_MAX` | 5, 375, 4, all | backtest: seconds between snapshots, pretend delay, questions at once, maximum snapshots |
| `BT_CACHE` | on | `0` stops the backtest from saving and reusing Jev's answers |
| `BENCH_N` | `20` | benchmark samples per scenario |

## Costs and limits

- **Jev:** $0.042 per million input tokens. A decision costs about three thousandths of a cent.
  The status lines and both reports show what a run actually cost
  ([latency.md](latency.md#costs)).
  - The news path costs cents a day.
  - The live market-data path at the default one question a second costs about $3 a day; back to
    back it's about $8.
  - A backtest says what it will cost before it starts, and never pays for the same answer twice.
- **AI Gateway without credits:** about 5 Jev calls every 5 minutes. Enough for the quieter news
  sources; not enough for the Benzinga stream during market hours, the live market-data path, or
  backtests of any size. **With credits** on the account we saw no limit at all.
- **Alpaca free plan:** stock prices from one exchange (IEX), up to 30 stocks at a time. Prices can
  be very wide outside trading hours.
- **X:** $0.005 per post read and $0.010 per account profile; searches that find nothing are free.
  The daily cap (`X_MAX_POSTS_PER_DAY`, default 500) keeps posts under $2.50 a day; with the
  default accounts it's usually cents. Profiles are looked up once per account, ever (6 cents for
  the defaults), and remembered in `data/cache/x-users.json`.
- **Coinbase, the public news feeds, and the SEC:** free.
- **Trading itself (not done here, only charged in the reports):** Coinbase charged 60 bp per fill
  for takers at its smallest tier and 5 bp at its largest when this was written, and a round trip
  pays it twice. At the cheapest of those, nothing at 10 or 60 seconds survives, even with perfect
  foresight almost every time ([accuracy.md](accuracy.md#what-trading-costs)).

## Running on a Raspberry Pi

A Raspberry Pi 5 with 8 GB of memory runs this comfortably. Measured on the development machine:
the news program peaked at 175 MB of memory and used about 2.6% of one processor core; the
market-data program 158 MB and about 2.4%. The Pi's processor is roughly two to three times
slower, so expect about 5 to 8% of one core each. Nearly all the time is spent waiting on the
network, so it will be just as fast on the same internet connection.

**Setting it up takes one script.** Clone the repo on the Pi, copy your `.env` over, and run
`./deploy/pi/setup.sh`. It installs Node.js 24 if needed, installs the packages, checks your keys,
and sets the news pipeline up as a background service that starts at boot, waits for the clock to
sync, restarts itself after a crash, and saves its pending records when stopped. Step-by-step
instructions and everyday commands are in [deploy/pi/README.md](../deploy/pi/README.md).

A few tips:

- Use the 64-bit Raspberry Pi OS, and a network cable rather than Wi-Fi if you can. Wi-Fi is where
  connections most often die silently; the pipeline notices and reconnects within about 10
  seconds (Coinbase) or 40 seconds (Alpaca), but a cable avoids it.
- If you'll also save market data around the clock (`--service record`, about 180 MB a day on the
  Pi in September 2026), use
  an SSD rather than the SD card, since constant writing wears SD cards out.
- A sudden power cut loses up to 30 minutes of pending news decisions; a normal stop or restart
  doesn't.

**Don't run it on the Pi and another computer at the same time.** Alpaca's free plan allows one
connection per stream, so the second copy would be refused. X costs would double, and on a gateway
account without credits the two copies would share the same few calls.

## Fixing common problems

| What you see | Why | What to do |
|---|---|---|
| "Free tier requests on this model are rate-limited" / many `429s` | the gateway account has no credits | add gateway credits, or ask less often; the engines already slow down by themselves |
| `out of credits; asking again in N min` / `no-credit` climbing in the status line | the TypeSafe account is empty | add credits (or turn on auto-reload) at TypeSafe; the engine checks again on its own, at most every 15 minutes, and carries on when they're back |
| `Failed to load TypeSafe API key` | `TYPESAFE_AI_API_KEY` missing from `.env` | add it, or set `JEV_PROVIDER=gateway` to use the other route |
| `GatewayAuthenticationError` | `AI_GATEWAY_API_KEY` missing from `.env`, or no longer valid | add it; if it was revoked, create a new one with `vercel ai-gateway api-keys create` |
| `model call failed (...); trying again in 2s` | a timeout or a hiccup at the gateway | nothing; news items are tried up to three times |
| `model error, item lost: ...` | three failures in a row, or the request was rejected outright | check the message; a rejected key or an SDK change needs fixing, a bad day at the gateway doesn't |
| `keep-warm requests to ... are failing` | the small requests that keep Jev's connection open aren't getting through | harmless by itself (calls just get about 100 ms slower); check your internet connection |
| `skip (AAPL quote is 400bp wide): ...` | the stock's bid and ask are too far apart to be a price, usually outside trading hours | expected; set `NEWS_ONLY_TRADABLE=0` if you want it asked about anyway |
| `skip (repeat of "..."): ...` | nearly the same headline arrived in the last 30 minutes | expected |
| `closed` count rising in the status line | stock news arriving while the US market is closed | expected; those can't be measured |
| `no Alpaca keys ... stock instruments will have no prices` | Alpaca keys missing from `.env` | add `ALPACA_API_KEY_ID` and `ALPACA_API_SECRET_KEY` |
| `[alpaca ...] error 402` | Alpaca keys wrong or revoked | make new ones in the Alpaca dashboard |
| `[alpaca ...] error 406` | another copy is already connected to Alpaca | run only one copy |
| `[alpaca ...] no reply in 10s, reconnecting` | the connection died without the computer noticing | nothing; it reconnects and refreshes its prices |
| `over-limit` in the stocks status | more than 30 stocks needed at once | expected on the free plan; those stocks aren't asked about |
| `[sec] company list failed ...; retrying` | the SEC's company list didn't download | nothing; it keeps retrying. Until it arrives, SEC filings can't be matched to tickers and questions use bare tickers |
| `edgar skipped: set NEWS_USER_AGENT` | the SEC requires identification | set your name and email in `.env` |
| `[news:x] HTTP 401` | X key wrong or revoked | make a new one in the X developer portal |
| `[news:x] HTTP 402` or `403` | no X credits, or the app lacks access | check your X developer account |
| `[news:x] HTTP 429` | too many X searches | it waits automatically; raise `X_POLL_S` if it keeps happening |
| `[news:x] daily budget ... reached` | the daily post cap was hit | it resumes at midnight UTC; raise the cap or follow fewer accounts |
| `[news:x] could not look up account ids` | the one-time lookup failed | nothing; posts show the author's id for now and it tries again in 10 minutes |
| `[news:...] HTTP 403` on a feed | the site blocks automated readers | remove that feed |
| `[coinbase] sequence gap ...` or `no messages for 10s` | a market message went missing, or the connection died | nothing; it rebuilds the book automatically, and prices during the break are recorded as unknown |
| the dashboard says a pipeline "isn't running" when it is | the pipeline was started with `TELEMETRY=0`, or the two use different ports, or they're on different machines | start the pipeline without `TELEMETRY=0`; check `TELEMETRY_PORT`; across machines set `TELEMETRY=<dashboard's address>` and `DASHBOARD_HOST=0.0.0.0` |
| the dashboard's scoreboard stays empty | decisions are scored once their outcome is saved, a minute later, and only when the price actually moved | wait; a quiet market fills it slowly |
| `listen EADDRINUSE` when starting the dashboard | another copy is already running, or something else uses the port | stop the other copy, or set `DASHBOARD_PORT` / `TELEMETRY_PORT` |
| no news for a long time | normal; old items are ignored and most sources post a few times an hour | test with `NEWS_MANUAL=1` |
| `-` in the report for long horizons | the run stopped before those horizons were reached | run longer |

## Changing things safely

**Adding an exchange:** see [feed.md](feed.md#adding-an-exchange).

**Adding a market measurement:** see [market.md](market.md#adding-a-measurement).

**Adding a news source:** see [news.md](news.md#adding-a-source). Only use official APIs and feeds
that allow automated reading.

**Adding stocks or other assets:** any US stock a source tags works automatically. Other
cryptocurrencies need a price source first (in `src/market/prices.ts`), a size scale for their
news questions in `src/news/questions.ts`, and removing from the "crypto symbols we can't price"
list in `src/news/instruments.ts`.

**Changing Jev's questions:** market-data questions live in `DIRECTIONS` in `src/model/jev.ts`;
news questions in `src/news/questions.ts`. Old result files keep the old questions, so only
compare runs that used the same ones. Backtest answers are filed under exactly what was asked, so
a changed question is simply asked afresh.

### Changing record formats

Records carry a format version (`v`, currently 2); files from before versions existed have none.
New fields that old files simply lack are fine: the reports treat anything missing as unknown. If
you change the *meaning* of an existing field, raise the version and teach the reports to read
both.

**Before spending real requests on a change:**

1. `npm run check` (type check and tests).
2. `JEV_PROVIDER=mock RUN_MINUTES=3 WARMUP_S=30 npm run live`, then `npm run analyze` on the
   output. The random answers must score about zero; anything else means the report is peeking
   at future prices.
3. For news changes: `NEWS_MANUAL=1 NEWS_SOURCES=none JEV_PROVIDER=mock npm run news` and type a
   few headlines. On a weekend add `NEWS_ONLY_TRADABLE=0` to try stock headlines.
