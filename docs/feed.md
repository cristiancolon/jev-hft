# Live market data

Code: `src/feed/`.

## What it does

The feed code connects to market data services and turns their messages into one standard
format (`MarketEvent`). The rest of the pipeline only ever sees that standard format.

**Why a standard format?** Every service describes the same things differently. Handling those
differences in one place means the rest of the code never has to care which exchange the data
came from, and adding a new exchange only touches this folder.

There are three kinds of standard event:

- **book**: a change to the order book (a price level's size went up, down, or to zero). A
  "snapshot" replaces the whole book at once.
- **trade**: a trade happened, with the side of the trader who made it happen (the buyer or
  seller who accepted a waiting offer).
- **reset**: data may have been lost (for example the connection dropped), so the book must be
  rebuilt from scratch.

Every event is stamped with the moment it arrived on our machine. That arrival time is the clock
the whole pipeline runs on ([architecture.md](architecture.md#1-one-clock-when-we-received-something)).

## Bitcoin from Coinbase (`coinbase.ts`)

We connect to Coinbase's free public WebSocket, which needs no account, and listen to three
channels:

- **level2**: the full order book. It starts with a snapshot of about 40,000 price levels, then
  sends changes.
- **market_trades**: every trade.
- **heartbeats**: a small message every second, whether or not anything is happening.

**Why Coinbase?** It was the fastest of the free Bitcoin feeds we tested from the US (about 31 ms
to reach us, versus 53 to 89 ms for others), it's a US exchange, and it sends the complete order
book.

Things worth knowing:

- **Coinbase labels trades by the waiting side, not the side that made the trade happen.** We
  checked this against the live order book and flip it, because our measurements need the side
  that made the trade happen. If you add another exchange, check this the same way; getting it
  backwards silently turns every "buying pressure" number upside down.
- **If a message goes missing,** Coinbase's numbering skips a number. The feed then emits a reset,
  reconnects, and rebuilds the book from a fresh snapshot. That's simpler and safer than trying
  to patch the gap.
- **If the connection goes silent,** it's replaced. Because of the heartbeats, 10 seconds without
  any message can only mean the connection has died, even when the computer hasn't noticed.
  That happens on Wi-Fi and home routers, and without this check the program would sit there
  looking healthy while seeing nothing.
- **Reconnecting** starts after half a second and waits longer after each failure, up to 10
  seconds. The wait only goes back to half a second once data is actually flowing again, so a
  server that accepts connections and immediately drops them isn't hammered.
- **Coinbase holds updates for about 47 ms (book) to 85 ms (trades) before sending them.** That
  delay is on their side, so getting closer to their servers can't remove it.

While the feed is broken (from the last good message until the next snapshot) the market state
treats Bitcoin's price as unknown rather than unchanged ([market.md](market.md#the-market-state-statets)).

## Bitcoin from Binance.US (`binanceus.ts`)

Recorded by `npm run record:binanceus` (on the Pi, the `jev-hft@record-binanceus` service), for
research only: nothing trades on it yet. It saves BTC/USD and BTC/USDT by default
(`BINANCEUS_SYMBOLS`), one file each, in the same standard form as Coinbase's, so a recording
replays through the same market state and the research scripts
([accuracy.md](accuracy.md)).

**Why record it:** Binance.US charges nothing for resting orders, and its market makers most
likely price off the big exchanges that refuse connections from the US (Binance's and Bybit's
main sites answered the Pi with "not available here"). So its quotes may move before Coinbase's,
or after them, and either would be worth knowing
([decisions.md](decisions.md#d58-binanceus-is-recorded-next-to-coinbase-by-a-program-of-its-own)).
It is a small market: about 4,000 BTC/USD trades and $1M a day in September 2026, against
Coinbase's hundreds of millions, so its book matters more than its trades.

We listen to two public streams, no account needed:

- **the order book's changes, every 100 ms** (`depth@100ms`), plus a snapshot of the whole book
  fetched over the web when connecting. The book was about 600 levels a side.
- **every trade** (`trade`).

Things worth knowing:

- **The book is rebuilt the way Binance says to**, and any missing update means starting over:
  the changes are held while the snapshot is fetched, the ones it already includes are dropped,
  and from then on each change must begin exactly where the last one ended. The rules live in
  `DepthSync`, which touches no network, so the tests check each one directly.
- **The snapshot has no time on it,** so the rebuilt book is stamped with the moment it arrived,
  and so are the changes held while waiting for it. That is when the book became known, and it
  keeps every recording in time order.
- **Binance labels a trade by whether the buyer was the waiting side** (`m`). When it was, the
  seller made the trade happen, and the feed flips it accordingly. In a first three-minute live
  check both trades printed on the side the label says (a sell at the bid, a buy at the ask); the
  book never crossed and matched a fresh snapshot at the end. Two trades is thin evidence, so it
  is worth checking again on a longer recording (step 3 below).
- **Its server pings every 20 seconds** and drops connections that don't answer within a minute
  (since 30 July 2026). Node answers pings by itself; a 90-second test from the Pi stayed
  connected. Changes came every 190 ms at the median and never more than 2.1 s apart, so 30
  seconds of silence counts as a dead connection.
- **Delay:** changes arrived 55 to 65 ms after Binance stamped them (this Mac, and the Pi). Being batched every
  100 ms, the book is seen in 100 ms steps; trades arrive one by one.

## Stock prices from Alpaca (`alpaca.ts`, `alpaca-stocks.ts`)

Alpaca provides US stock prices and news. `alpaca.ts` handles the connection for both: signing
in, reconnecting after drops (waiting longer each time, up to 30 seconds), and signing back up
for whatever we were following. Other code never has to think about the connection.

**Knowing a quiet connection is still alive.** Unlike Coinbase, these streams can be silent for
hours: there's no stock news at 3 a.m. and no quotes on a Sunday. Silence proves nothing. So every
30 seconds the connection re-sends the list of things it's already following, which Alpaca
confirms within a tenth of a second. Whenever we send anything and hear nothing at all for 10
seconds, the connection is treated as dead and replaced. Nothing invalid or made-up is ever sent.

`alpaca-stocks.ts` keeps each stock's bid and ask over time. On the free plan it can follow at
most 30 stocks at a time, from one exchange (IEX). So stocks are switched on when news about them
arrives and switched off when they're no longer needed ([news.md](news.md#prices)).

When a stock is switched on, two requests go out at the same moment, so they take no longer than
one:

- its **latest quote and last closing price**, so there's a starting price right away and the
  model can be told how far the stock has already moved today;
- its **one-minute prices for the last 40 minutes**, so the model can also be told what the stock
  did over the last 1, 5, and 30 minutes. These older prices are used only as background. They
  never feed the measurement of what happened *after* the news.

**If the connection to Alpaca drops,** stock prices are treated as unknown from the last message
we received until quotes are flowing again, exactly like Bitcoin during a Coinbase outage. On
reconnecting, every followed stock's quote is refreshed first, because Alpaca only sends a quote
when it changes and a quiet stock might otherwise show its pre-outage price for minutes.

**Stocks over the 30-stock limit** still get a one-off price (so the record shows what it was),
but it's forgotten after two minutes rather than left lying around to be mistaken for a current
price later.

Stock prices here are just the best bid and ask, not a full order book. Free IEX prices are
reliable for big, heavily traded stocks during regular hours, but can be thin for small companies
and very wide outside trading hours.

## Adding an exchange

1. Turn its messages into standard events, stamping the arrival time.
2. Emit a reset whenever data might have been lost, and find a way to tell a dead connection from
   a quiet one.
3. Check which side its trade labels mean, against its order book.
4. Check the order book: after a few minutes, compare it with a fresh snapshot. The best bid and
   ask must match, and the bid must never be at or above the ask. (Don't compare against an
   exchange's "ticker" channel: Coinbase's only updates on trades, so it lags the book.)
5. Measure its delays before assuming it's faster.
