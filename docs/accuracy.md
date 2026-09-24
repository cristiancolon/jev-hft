# Accuracy at 10 and 60 seconds, and what trading costs

Code: `research/extract.ts`, `research/fit.py`, `src/market/microstructure.ts`,
`src/model/ridge.ts`, `src/model/weights/`, `src/model/costs.ts`, `src/dashboard/pnl.ts`.

## The question

Which way will Bitcoin's price go over the next **10 or 60 seconds**? Those are the two
horizons long enough to place an order and have it filled before the call goes stale. And once
the cost of trading is paid, is anything left?

The short answers, from four days of data the Raspberry Pi recorded:

- **At 10 s the order book is right about 56% of the time, and up to 67% on its strongest calls
  in calm markets.** A small linear model of the book (the "order-book model") now does that
  job in the pipeline. Jev, on the same seconds, was right 52%.
- **At 60 s nothing tried beats a coin flip**: not the book, not 80 measurements, not boosted
  trees, not Jev.
- **No trade at either horizon pays for itself at any fee Coinbase publishes.** The strongest
  calls catch about 0.4 bp a trade; the cheapest taker round trip costs 10 bp. Even perfect
  foresight could pay for a round trip in only 0.4% of 10-second windows at that fee.

## The data

The Pi recorded every Coinbase book and trade event from 2026-09-20 02:00 to 2026-09-24 04:20
UTC: 8.3 million events, turned into **353,149 one-second snapshots**. Jev answered 154,172 of
those seconds. From 2026-09-22 20:33 to 2026-09-23 23:24 UTC it answered almost none, because
the TypeSafe account had run out of credits (the engine now pauses when that happens, see
[decisions.md](decisions.md#d56-running-out-of-credits-pauses-the-engine-for-minutes)).

## How it was tested, and why this way

- **The same code as the live pipeline.** `research/extract.ts` replays the recording through
  the pipeline's own market state and writes one row a second. The numbers a fit learns from
  are the numbers a live run sees.
- **Tradable prices.** Each move is measured from **300 ms after** the snapshot, at the bid and
  ask actually on the book then, because nobody can trade the instant a call is made.
- **Tested on days the fit never saw.** Each fit learns from earlier days and is scored on the
  next one. The last full day, **2026-09-23, was locked away** until every choice was made, then
  scored once. A result that only holds on the days used to choose it proves nothing.
- **Honest error bars.** Snapshots one second apart share most of their future, so the
  uncertainty is worked out from the number of separate 10 or 60 second stretches, not the
  number of rows.
- **Compared at the same number of trades.** "The strongest quarter" means the quarter of calls
  with the biggest predictions, picked from the predictions alone, never from what happened next.

## What was found at 10 seconds

Share of calls that pointed the right way (moves of exactly zero left out), on the locked day:

| Signal | All calls | Strongest quarter | Strongest tenth |
|---|---|---|---|
| Book imbalance at the best level (the old simple rule) | 55.6% | 60.7% | 61.2% |
| **Order-book model** | **55.7%** | **62.2%** | **63.5%** |
| **Order-book model, calm market and one-tick spread** (63% of that day's seconds) | **58.2%** | **65.5%** | **67.0%** |

On the two earlier test days (2026-09-21 and 22) the model scored 54.7%, 59.3% and 60.6%, and
57.5%, 64.5% and 66.7% in calm markets. One standard error is about half a point on all calls
and about two points on the strongest tenth.

- **Jev adds nothing here.** On the same seconds, Jev's answer (read against its usual lean)
  was right 52.2% of the time, 53.7% on its strongest tenth. Adding it to the model's inputs
  changed nothing (54.5% with it, 54.7% without).
- **Six measurements of the book are enough.** The model uses book imbalance over the best 1,
  2, 3 and 5 levels, the microprice, and how the two best queues compare. 80 measurements
  including order flow, trade flow, momentum and time of day did no better (54.8%). Neither did
  boosted trees (55.0%), which would also be harder to run live. **Why:** order flow explains
  the move that is happening now, not the next one.
- **Its size means something.** When it expects a move of +0.4 bp, the price moved +0.4 bp on
  average; each tenth of its predictions matched what followed within a few hundredths of a bp.
  That matters for costs: a trade can only be weighed against a fee if the size of the expected
  move is real.
- **Speed matters a lot.** Entering at once, 300 ms later, or a second later, the model was
  right 55.5%, 54.7% and 53.5% of the time; on its strongest tenth, 63.0%, 60.6% and 57.4%.
  **Half the edge is gone within a second.**
- **Calm markets are where the book works.** When the last minute was quiet (60-second
  volatility under 0.64 bp, the two-thirds mark of the training days) and the spread was one
  cent, the model was right 57.5% of the time, against 53.2% the rest of the time. When the
  spread is wider than a cent (18% of seconds) the book says almost nothing (51.7%). This is
  also why accuracy seemed to swing by the hour: the hours differed in how calm they were.

## What was found at 60 seconds

Nothing separates from chance. The best anything managed on the earlier test days was 51 to 52%
(one standard error: about a point); on the locked day the order-book model scored 51.5% and
the plain rule 52.1%. Jev scored 49.2%, slightly the wrong way. The 60 s model is kept running
live anyway, at no cost, so its record keeps testing this.

## What trading costs

A taker pays twice for every round trip:

- **The exchange's fee, on each fill.** Coinbase Advanced Trade's published schedule ran from
  60 bp per fill at its smallest tier down to 5 bp at its largest when this was written (makers,
  who wait for others to take their order, paid 40 down to 0). Check the current schedule.
- **The spread**, since it buys at the ask and sells at the bid. On BTC-USD this is usually a
  single cent, about 0.001 bp, and 0.05 bp on average. For this product the fee is nearly the
  whole cost.

Against the order-book model at 10 s, calm markets only, strongest tenth of calls, on the
earlier test days:

| | per trade |
|---|---|
| Move caught | +0.46 bp |
| Spread | −0.03 bp |
| Largest fee per fill it could pay and break even | **about 0.2 bp** |
| After two 5 bp fees (Coinbase's cheapest taker rate) | **−9.6 bp** |
| After two 60 bp fees (its smallest tier) | −119.6 bp |

The locked day looked the same: its strongest tenth caught +0.36 bp a trade, enough to pay a fee
of 0.16 bp a fill. Even a perfect prediction does not survive: at 5 bp per fill, only 0.4% of 10-second windows,
and 6.6% of 60-second ones, moved far enough to pay for a round trip.

**So better accuracy at these horizons cannot be turned into profit by taking prices on
Coinbase.** The accuracy is real and useful as a building block, but the money has to come from
paying less or knowing more (below).

## What the pipeline does with this

- **Every decision records the order-book model's expected move** at 10 and 60 s
  (`signals.ob_10s`, `signals.ob_60s`, in bp), with the bid and ask at the snapshot and when
  Jev's answer arrived, and the minute's volatility ([engine.md](engine.md#whats-recorded-for-each-decision)).
  It is worked out in about 10 µs, after Jev's request has already been sent, so it never
  slows Jev down, and it adds nothing to the handling of each market event.
- **Every trade in the reports and on the dashboard pays for itself**: the fee on both fills
  (`FEE_BPS_PER_SIDE`, 5 by default) and the spread (`src/model/costs.ts`). Each also keeps what
  the moves alone were worth, so a signal that is right but too small to trade can be told apart
  from one that is wrong.
- **A new dashboard card trades the order-book model**, and it is the only rule that looks at
  the cost first: it takes a call only when the move the model expects is bigger than the round
  trip, and at 10 s only in a calm market. At real fees it takes almost nothing, and the card says
  how close it came ([dashboard.md](dashboard.md)).
- **The scoreboard and the report score the order-book model** next to Jev and the simple rules.

## Where an edge could still come from

1. **Pay less per trade.** Resting limit orders (maker) at a zero-fee tier, or a venue with lower
   fees. Whether a resting order fills, and whether it fills mostly when it shouldn't, has to be
   simulated; the recording has every trade, so a cautious simulation is possible.
2. **Know more.** Prices on other exchanges often move first, and that kind of lead is the most
   likely source of a 10 to 60 second signal. Binance's and Bybit's main sites refuse connections
   from the US, so the Pi records Binance.US instead, whose market makers most likely price off
   them (`npm run record:binanceus`, [decisions.md](decisions.md#d58-binanceus-is-recorded-next-to-coinbase-by-a-program-of-its-own)).
   Coinbase's own perpetual futures are another candidate.
3. **Go longer, with news.** News moves prices by far more than 10 bp, which is why the news path
   exists.
4. **Jev on market data isn't earning its keep** at these horizons (about $3 a day for one
   question a second). Its understanding of language is more likely to matter on news.

## Refitting

The weights in `src/model/weights/` were fitted on 2026-09-20 to 22 and tested on 2026-09-23.
Markets change, so refit every few weeks, and whenever the scoreboard shows the model slipping:

```bash
# 1. Copy the recording off the Pi (it grows by about 180 MB a day)
rsync -a cristicol@<pi>:code/jev-hft/data/raw/ data/raw/
# 2. One row a second, through the pipeline's own code (about 2 minutes for four days)
node research/extract.ts data/raw/BTC-USD-<start>.jsonl.gz data/research/rows
# 3. Fit and test on the earlier days. Make every choice here.
pip install numpy lightgbm        # LightGBM is optional: it only adds the tree comparison
python3 research/fit.py data/research/rows --jev data/decisions/live-*.jsonl
# 4. Only then, once: score the locked last day and write the weights
python3 research/fit.py data/research/rows --final --export src/model/weights
# 5. Check the pipeline reads them and agrees with Python to the last digit
npm test
```

Keep to the order. Looking at the locked day before the choices are final turns it into one more
day to fit to, and then nothing has been tested. The full printout of the fit this page describes
is saved as `data/research/fit-report.txt` on the machine that ran it.
