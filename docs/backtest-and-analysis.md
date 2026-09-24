# Recording, replaying, and judging the results

Code: `src/record.ts`, `src/backtest.ts`, `src/market/replay.ts`, `src/analyze.ts`,
`src/analyze-news.ts`, `src/lib/stats.ts`.

## Why test on recorded data first

Two different questions need answering:

1. **Does Jev see anything useful at all?** This doesn't depend on speed, and it takes thousands
   of decisions to answer.
2. **Can we act on it before the market moves?** This depends entirely on speed.

Testing the first question live is slow: one decision a second at best, and about one a minute on
a gateway account without credits. So the plan is: record market data, replay it and ask Jev
about many past moments at once, and only work on speed if there's something worth capturing.

## Recording (`npm run record`, or `RECORD=1 npm run live`)

Saves every standard market event from Coinbase into a compressed file under `data/raw/`. It
saves the tidied-up events rather than Coinbase's raw messages, so replays don't need any
Coinbase-specific code.

`npm run record` does only this and makes no model calls, so it's free and can run for as long
as you like. `RECORD=1 npm run live` writes the same file while also deciding, which is what you
want when the point is to replay exactly what a live run saw
([engine.md](engine.md#saving-the-data-as-well)). Connection breaks are saved too, so a replay knows when the price was
unknown. Three minutes came to about 4,000 events and 552 KB, which works out to roughly 11 MB an
hour.

## Replaying (`npm run backtest -- <file>`)

1. Feeds the recording through the same market-state code the live run uses.
2. Every `STEP_S` seconds (default 5), after a warm-up, takes a snapshot and writes Jev's text.
   Each snapshot is taken *before* applying the next event, so it only knows what was known at
   that moment. **That ordering is what keeps the backtest honest.** It lives in one small
   function (`replayer()` in `src/market/replay.ts`) with a test that fails if it's ever changed.
3. Says how many calls it's about to make and what they'll cost, then asks Jev about the
   snapshots, several at a time (`BT_CONCURRENCY`). If refused for too many requests, it waits and
   tries again instead of skipping, because completeness matters more than speed here.
4. Pretends each answer arrived `BT_LATENCY_MS` later (default 375 ms) and looks up the prices
   from that moment.
5. Writes the results in the same format as live runs, so the same report reads both.

The pretend delay is fixed, while real delays vary (a slow case is about 320 ms through the
gateway today, and was 550 ms on the free tier). Try a pessimistic `BT_LATENCY_MS` to see how
much it matters; thanks to the cache below, trying another value costs nothing.

### Answers are paid for once

Every answer is saved in `data/cache/jev-answers.jsonl`, filed under exactly what Jev was shown:
the text, the questions' thresholds, and which model. Running a backtest again on the same
recording reuses those answers.

**Why:** the delay we pretend (`BT_LATENCY_MS`) and the way results are scored don't change what
Jev was asked, so there's no reason to pay for the same answers again to try a different delay or
after fixing the report. It also means a backtest that was interrupted, or that is crawling along
under a rate limit, picks up where it left off. The practice model's answers are random, so they
are never kept. `BT_CACHE=0` turns the cache off; deleting the file empties it.

## The market-data report (`npm run analyze -- <files>`)

It starts with how much time the decisions cover, how many tokens a decision used, and what the
run cost. Then it prints five sections.

**1. Where the time went:** how old the data was, how long the text took, how long Jev took (and,
for live runs, how much of that was TypeSafe itself against the network and gateway), and the
total. Each is shown as typical (median), slow (90th percentile), and very slow (99th).

**2. The "perfect foresight" line:** for each horizon, the average size of the price move. No
prediction can earn more per trade than this, so compare it with your trading cost before
anything else. In our recorded data it was 0.05 to 0.1 bp at 1 second and 1 to 4 bp at 60
seconds, while a round trip really costs somewhere around 10 bp. That's why this path can't be
profitable at these horizons, however good the predictions.

A round trip is charged the exchange's fee twice (`FEE_BPS_PER_SIDE`, 5 bp by default,
Coinbase's cheapest taker rate) plus the average spread of the decisions scored; the first line of
the report says what that came to. Set `FEE_BPS_PER_SIDE=0` to see what the moves alone were
worth.

**3. How good each signal was,** for Jev, the four simple rules, and the order-book model
(`ob_*`, [accuracy.md](accuracy.md)), at each horizon. The order-book model is scored twice, from
the snapshot like the simple rules, and from when Jev's answer arrived, which is when the
dashboard's profit and loss trades it:

| Column | Plain meaning |
|---|---|
| `n` | how many decisions were scored |
| `ind` | how many of them are far enough apart to count as separate evidence |
| `IC` | how well the signal ranked what happened, from −1 to +1 (0 means no relationship) |
| `t` | how confident we can be that the IC isn't luck; roughly, above 2 starts to mean something |
| `hit%` | how often the signal pointed the right way |
| `Q5-Q1bp` | how much better the strongest "up" calls did than the strongest "down" calls |
| `net edge bp` | what trading on the strongest calls would have earned per trade, after costs |

Jev is scored from when its answer arrived (what you could actually trade). It's also shown
"@state", scored from the snapshot, to see whether it saw something real even if too late to
use. The simple rules are scored from the snapshot, since they take no time to compute.

`jevc_*` is the same answer with Jev's usual lean taken out
([model.md](model.md#reading-jevs-lean-against-its-usual-one)). Its `IC` is nearly the same as
the plain answer's, because shifting every answer by about the same amount doesn't change how
they rank. Its `hit%` is higher, because which way an answer points depends on where zero is.

**About `ind` and `t`.** Two decisions a second apart, each looking 60 seconds ahead, are looking
at almost the same minute. They're one piece of evidence, not two. So the report walks through the
decisions in time order and counts one only if it comes at least a full horizon (and at least 5
seconds) after the last one it counted. The confidence score is worked out from that count.

This matters most when decisions come in bursts, which is exactly what a rate limit produces. An
earlier version divided the run's total length by the horizon instead. Five decisions in two
seconds, then a five-minute pause, then five more, counted as thirty pieces of evidence when
there were really two. In a 2.5-minute test recording, 178 decisions at the 60-second horizon
are 2 separate pieces of evidence, and the report now says so.

**The "beyond the rules" line.** Under each horizon that Jev was asked about, one more line shows
what's left of Jev's score once the four simple rules are accounted for. It removes from both
Jev's signal and the price move whatever the rules already explain, then measures what remains.
**Why:** Jev is shown the same numbers the rules are built from, so a good score on its own
doesn't tell you whether Jev understood something or just repeated book imbalance back to us. A
signal that only echoes the rules scores about zero on this line however well it scores alone.
This is the line that says whether Jev is adding judgment. On our 31-minute recording Jev scored
0.10 to 0.17 on its own at 2 and 10 seconds, and between −0.14 and 0 on this line.

**4. Jev's lean:** for each question, how one-sided Jev's answers were next to how one-sided the
market really was, and what reading them against its usual lean was worth. Four lines each:

- how often the price rose, against how often Jev leaned up (on a nine-hour run: 50% against 13%);
- how often Jev pointed the right way as answered, and with its usual lean taken out, with the
  best level of the order book alongside for comparison;
- the same split into fifths by how strong the corrected lean was, weakest first. This should
  rise from left to right. If it stops rising, a stronger lean has stopped meaning more, and
  staking by it no longer makes sense;
- how often Jev and the book agree, how often they are right when they do, and how often Jev is
  right when they don't. The dashboard's selective rule sits out the disagreements because this
  last number has been below half.

**Why it's in the report:** these are the findings the pipeline's corrections rest on, and they
came from one day. Printing them for every run means they get checked again on other days
instead of being trusted. Files from before the correction existed are read the same way, so old
runs can be compared with new ones.

A backtest needs its snapshots close together for this: the usual lean is only known once there
are 60 answers within 15 minutes. With `STEP_S` above 15, or a small `BT_MAX` spread over a long
recording, the section says there were too few.

**5. Late arrival and calibration:** how much the price moved while Jev was thinking, and whether
Jev's probabilities match reality (when it says 70%, does it happen about 70% of the time?). Each
decision is judged against the "flat" threshold it was actually asked with, since those now
change with the market ([model.md](model.md#the-market-data-questions)). Below each line is Jev's
average answer (say, up 0.20 / flat 0.55 / down 0.25); comparing that with how often each really
happened shows whether the thresholds suit the market.

## The news report (`npm run analyze:news -- <files>`)

It starts with how many decisions and model calls there were, where they came from, how many were
left out of the price measurements and why, and what the calls cost. Bitcoin and stocks are then
reported separately.

1. **How fast news reached us,** per source, how long items waited, how long getting prices ready
   took, and how long Jev took.
2. **Does Jev know which news matters?** The average price move after items Jev called relevant
   (and after those it also called new), compared with items it didn't, and whether its "how
   big", "relevant", and "new" answers lined up with the actual size of moves. This is checked
   first because it takes far fewer examples to show than direction.
3. **Does Jev know the direction?** For relevant items, did prices move the way it said? The
   `events` column and `t` work like `ind` above: records about the same asset count once per
   horizon-long stretch of time, so five stories about one company in ten minutes aren't treated
   as five independent tests. Underneath, a small table tries different ways of combining Jev's
   answers into one number, to see which ranks price moves best.
4. **How much was already gone** before we could act: moves between publication and when we got
   the item, and while Jev was thinking.
5. **The items themselves,** most relevant first.

**A stock's price move only counts if there was a usable price at both ends.** The bid and ask
must be within `MAX_SPREAD_BPS` (default 50 bp) when Jev answered *and* at the later moment being
checked, and the market mustn't have been closed. **Why both ends:** a story at 3:50 pm has its
30-minute check at 4:20 pm, after the close, when free quotes can be several percent wide. The
midpoint of such a quote can sit far from the last real price, and would show up as a large "move"
that never happened. Older records that didn't store later spreads are checked at the start only.
Records made before stocks were added are treated as Bitcoin.

News arrives slowly, a few items an hour from most sources, so treat the numbers as anecdotes
until there are hundreds of relevant items.

## The math helpers (`lib/stats.ts`)

Percentiles, averages, rank correlation, the separate-evidence count, and two safety helpers
every report uses: `num()` turns anything that isn't a number into "unknown", and `bps()`
measures a price change, giving "unknown" if either price is missing. They exist because of a
real bug: unknown prices are saved as `null`, and `null` quietly acts like zero in math, which
once turned every unfinished horizon into a fake −10,000 bp crash.

## How we checked the reports themselves

- With the random practice model, Jev's scores came out at about zero with `t` under 1, as they
  should. That shows the reports aren't accidentally peeking at future prices. Run this check
  again after changing anything in the reports or the backtester:
  `JEV_PROVIDER=mock npm run backtest -- <file>`, then `npm run analyze` on the result.
- The correction for Jev's usual lean got the same treatment, on a much larger scale. In a
  nine-hour run (30,312 decisions) every one of Jev's answers was replaced with a random one
  that leaned "down" as heavily as the real ones do, then put through the same code. The
  corrected lean scored 0.00 and pointed the right way exactly 50% of the time, with no sign of
  stronger leans doing better. So the correction can't turn nothing into something. It also
  took away the little the random answers had: leaning down on a day the price drifted down had
  made them "right" 51 to 52% of the time, and that luck went with the lean.
- The simple rules showed small positive scores at 1 to 5 seconds, which is what's normally seen
  for these rules (the samples were too short to be conclusive).
- Unfinished horizons show as `-`, never as zero.
- The statistics, the no-peeking rule, and "unknown during an outage" all have tests
  ([testing.md](testing.md)).
