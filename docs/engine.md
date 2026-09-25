# The live market-data loop

Code: `src/engine.ts` (the loop) and `src/live.ts` (the program that runs it). Run it with
`npm run live`.

## What it does

Once a second it records what the order-book model ([accuracy.md](accuracy.md)) expects of
Bitcoin's price over the next 10 and 60 seconds, from the freshest possible view of the market,
together with what the price did next. The decision is acted on 300 ms after its snapshot, the
time the research allowed for an order to reach the exchange.

With `JEV_MARKET=1` it also asks Jev each time, and acts when the answer arrives; everything
below about questions, answers, and pauses applies only then. That is off by default: over five
days Jev's calls added nothing the book didn't already say, and used nearly all of the account's
credits ([decisions.md](decisions.md#d63-jev-is-not-asked-about-the-market-every-second)).

## How a decision happens

1. A market update arrives and is applied to the market state.
2. If the engine is allowed to ask Jev right now, it takes a snapshot of the market, turns it into
   text, works out what "flat" should mean at the current volatility, and sends the questions.
3. When Jev answers, the engine notes the time and the current price, and holds the record.
4. Sixty seconds later, it fills in the prices at 1, 2, 5, 10, 30, and 60 seconds after the
   answer, and writes the record to disk.

## When it's allowed to ask

| Check | Default | Why |
|---|---|---|
| The order book is loaded | after the first snapshot | nothing to describe before that |
| Warm-up time has passed | 60 seconds (`WARMUP_S`) | measurements like "60-second change" need 60 seconds of history; asking earlier fills Jev's text with "n/a". It starts over whenever the feed breaks |
| No question already waiting | 1 at a time (`JEV_MAX_INFLIGHT`) | one at a time keeps every answer as fresh as possible |
| Minimum gap between questions | 1 second (`JEV_MIN_INTERVAL_MS`) | see below |
| Not paused after "too many requests" | pause 5 s, doubling up to 60 s | respect the rate limit without hammering it |
| Not paused after "no credits left" | pause 1 minute, doubling up to 15 minutes | an empty account doesn't refill in seconds; asking every second only fills the log ([decisions.md](decisions.md#d56-running-out-of-credits-pauses-the-engine-for-minutes)) |

**Why once a second, and not as fast as possible?** Asking again the moment an answer comes back
gives about 2.7 decisions a second and costs about $8 a day. But decisions that close together
are looking at almost the same few seconds of market, and the report deliberately counts
stretches of time rather than decisions
([backtest-and-analysis.md](backtest-and-analysis.md#the-market-data-report-npm-run-analyze----files)).
So most of that money buys the same information again. One a second costs about $3 a day, and
each decision is exactly as fresh, because every question still uses a snapshot taken at the
moment it's sent. Set `JEV_MIN_INTERVAL_MS=0` to go back to back.

**Why not keep several questions going at once?** You'd get more answers, but each would still be
about a quarter of a second old when it arrived.

**Why not retry a question that was refused?** The next snapshot is just as good, and fresher.

**Why a 2-second timeout?** An answer that late would describe a market that has already moved on.

## What's recorded for each decision

| Field | Meaning |
|---|---|
| `v` | the record format's version (2) |
| `mode`, `provider` | live or backtest; gateway, direct, or mock |
| `tState` | when the snapshot was taken |
| `exchLagMs` | how old the newest market data in the snapshot was |
| `buildMs` | time to measure the market and write the text |
| `modelMs`, `providerMs` | how long the whole round trip to Jev took, and how much of that was TypeSafe itself (the rest is the network and the gateway) |
| `tResp` | when Jev's answer arrived: the earliest moment anyone could act on it |
| `inputTokens`, `costUsd` | how much text was sent and what the call cost at list price |
| `state` | exactly the text Jev saw, so any decision can be looked at again later |
| `flatBps` | the move that counted as "flat" in each of this decision's questions |
| `probabilities`, `confidence` | Jev's raw answers, and how sure TypeSafe says it was of each (the probability of the answer it picked) |
| `lean` | what Jev's lean had usually been over the 15 minutes before this answer, per question, and how far its leans typically strayed from that; unknown for the first minute of a run |
| `signals` | Jev's signal for each horizon as answered (`jev_*`), the same with its usual lean taken out (`jevc_*`, which is what gets acted on), four simple rules computed from the same snapshot (book imbalance at 1 and 5 levels, 5-second order flow, 5-second momentum), and the order-book model's expected move in bp over 10 and 60 seconds (`ob_10s`, `ob_60s`, [accuracy.md](accuracy.md)) |
| `quote`, `quoteResp` | the best bid and ask at the snapshot and when the answer arrived: what a trade placed then would have had to cross. A backtest has only the first |
| `vol60` | how much the price had been jumping about over the last minute, at the snapshot: the order-book model is right more often when it is low |
| `midState`, `midResp` | the price at the snapshot and when the answer arrived |
| `fwdState`, `fwdResp` | the prices at each horizon, measured from the snapshot and from the answer |

- **Why keep the simple rules in every record?** The real question is whether Jev beats them after
  its delay. Without them, a Jev result couldn't be judged.
- **Why work out the order-book model after Jev has been asked?** It takes about 10 µs, but the
  request is sent first anyway, like the dashboard's messages, so nothing it does can delay Jev.
  It reads the book once per decision and adds nothing to the handling of each market event.
- **Why save the bid and ask?** So every trade in the reports and on the dashboard can be charged
  the spread it would really have crossed, not just a fee ([decisions.md](decisions.md#d55-every-trade-pays-two-fees-and-the-spread-and-the-fee-is-set-per-fill)).
- **Why store prices instead of price changes?** So the report can measure changes any way it
  likes later, without rerunning anything.
- **Why measure from two moments?** From the snapshot shows whether Jev saw something real; from
  the answer shows whether anyone could have traded on it
  ([architecture.md](architecture.md#3-every-decision-is-judged-twice)).
- **Why record the thresholds?** They change with the market, and the report has to judge each
  answer against the question that was actually asked.
- **Why record both the answer and the corrected lean?** Jev leans "down" most of the time
  whatever the market does next, so its answer is read against what it has usually been saying
  ([model.md](model.md#reading-jevs-lean-against-its-usual-one)). Keeping both, and the usual lean
  itself, means the correction can always be checked against the plain answer it started from.
  The engine works it out when the answer arrives, from earlier answers only, so a record holds
  exactly the call a live run could have made at that moment.

If the run stops before a record's 60 seconds are up, the record is still written, with "unknown"
for the prices that hadn't happened yet. The same goes for any price that falls inside a feed
outage.

## Saving the data as well

`RECORD=1 npm run live` also writes every market event it sees to `data/raw/`, exactly as
`npm run record` would, so the same run can be replayed later with `npm run backtest`.

**Why not just run both programs?** You can, and nothing breaks: they open separate connections
to Coinbase, which is free and unlimited. But two connections receive slightly different things.
Messages arrive at different moments, a gap or a reconnect hits one and not the other, so the
arrival times differ. Recording from inside the live run instead guarantees the file holds
exactly the events that run saw, which means replaying it reproduces that run's decisions rather
than something close to them.

It costs about 40 millionths of a second per event (roughly double the per-event work, which is
still about 0.02% of a decision) and about 11 MB an hour of disk.

## The status line

Every 10 seconds `npm run live` prints something like:

```
mid 81205.74  ev/s 20  feed lag p50 86ms  event cost p50 48µs p99 1302µs  decisions 50  written 0  model 267ms  429s 0  timeouts 0  errors 0  no-credit 0  cost $0.0017
```

That's the price, market updates per second, how delayed the market data is, how long each
update took to handle, decisions made and written, Jev's last response time, how many requests
were refused, timed out, failed, or turned away because the account had no credits, and what the
run has cost so far.

## Tested

- The loop's rules (warm-up, spacing, pausing after a refusal, starting over after a feed break,
  what goes into a record) have tests that run without any network ([testing.md](testing.md)).
- With the mock model on live data: one decision a second, all written correctly on a clean stop,
  and the report scored the random answers at about zero, as it should.
- With the real gateway: 69 decisions in 75 seconds at a typical 270 ms each, one timeout, no
  refusals (on an account with credits). On an account without credits, 5 decisions each time the
  rate limit allowed, pausing correctly when refused.
