# Design decisions

A short record of the main choices behind this project: what we chose and why, in plain
words. Where it helps, each entry also says when the choice should be rethought.

---

## D1. Paper trading only

**Chosen:** the pipeline records decisions and what prices did afterwards. It never places trades.

**Why:** we don't yet know whether Jev's judgments make money. Real trading adds accounts, order
handling, and risk controls that only make sense once the reports show a real edge. If that day
comes, trading should be added as a separate layer on top, not mixed into the existing code.

## D2. Coinbase for Bitcoin data

**Chosen:** Coinbase's free public feed: full order book and trades, no account needed.

**Why:** it was the fastest free Bitcoin feed we tested from the US, it's a US exchange, and it
sends the complete order book with numbered messages, so we can tell when one goes missing.

## D3. One clock: when data arrived on our machine

**Chosen:** all timing uses the moment data arrived on our machine, not the times exchanges or
news services stamp on it. For a news feed, "arrived" means the whole feed had downloaded.

**Why:** what matters is when *we* knew something. Outside timestamps come from other computers
and don't agree with each other. One local clock also makes replays exact.

## D4. Market state changes only when data arrives

**Chosen:** the market state is only updated by incoming events; it never uses timers or reads
the clock.

**Why:** replaying recorded data then gives exactly the same results as the live run, which is
what makes backtests trustworthy.

## D5. One simple program per path, in TypeScript with no build step

**Chosen:** each path is a single Node.js program. Node 24 runs the TypeScript files directly.

**Why:** our own processing takes a tiny fraction of the time (well under a millisecond, against
about 260 ms waiting for Jev), so a faster language or more threads wouldn't change anything
noticeable. Running the source directly means what's in the repo is exactly what runs.

## D6. Call Jev through Vercel's AI SDK

**Chosen:** the pipeline calls Jev through the AI SDK. Only the speed benchmark makes requests by
hand.

**Why:** the SDK checks Jev's answers for us and lets us swap between the gateway, TypeSafe's
direct API, and the mock model without touching anything else. The benchmark is the exception
because it needs to time each step of a request, which the SDK doesn't allow.

## D7. Use the gateway by default; going direct is one setting away

**Chosen:** requests go through Vercel AI Gateway unless `JEV_PROVIDER=typesafe` is set.

**Why:** the project was set up around the gateway: one key, one bill. But more than half of each
round trip is the route rather than the model, and TypeSafe's own servers answer us in about 40 ms
against the gateway's 95 ms at best, so the direct route is the biggest speed-up available.
**Rethink** once a TypeSafe key is available: compare the two and consider going direct.

## D8. `ask()` never retries; each engine decides for itself

**Chosen:** the function that calls Jev makes one attempt. The market-data engine never asks
again: requests taking over 2 seconds are abandoned and the next snapshot is used instead. The
news engine tries a failed item again, up to three calls in all.

**Why:** a retried market answer arrives late and describes a market that has already moved on,
and a fresh snapshot is always available. A news item is different: there's only one of it, its
answer is still useful a few seconds late, and we've seen the gateway time out on an otherwise
healthy day. Only passing failures are retried (timeouts, network trouble, server errors); a
rejected key would fail the same way again.

## D9. Ask several questions in each call

**Chosen:** the market-data path asks about 2, 10, and 60 seconds ahead in one call. The news
path asks about every asset an item concerns in one call.

**Why:** Jev answers questions at the same time, so extra questions cost almost no time. The text
is also counted once however many questions are asked about it, so it's cheaper. More horizons
also help us find which one, if any, Jev is good at.

## D10. Send Jev summaries, not raw data

**Chosen:** Jev reads about seven labeled lines of market measurements, with notes on which ones
are unusual right now.

**Why:** sending more text didn't make Jev any slower, but it cost up to 15 times more. A few
well-chosen, labeled numbers say more than a long list of raw prices.

## D11. Write records once, when they're complete

**Chosen:** a decision is written to disk only after its last price check (60 seconds for market
data, 30 minutes for news).

**Why:** every line in a results file is complete, so reports stay simple. The cost: if the
program crashes (as opposed to being stopped normally), unfinished records are lost. Raw news
items are saved immediately, so those survive either way.

## D12. Judge every decision from two moments

**Chosen:** each record has the later prices measured both from when the snapshot was taken and
from when Jev's answer arrived.

**Why:** the first shows whether Jev saw something real; the second shows whether anyone could
have acted on it in time. Confusing the two makes slow strategies look profitable on paper.

## D13. Keep simple rules next to every Jev answer

**Chosen:** every market-data record also stores four simple signals (book imbalance at two
depths, recent order flow, recent momentum) from the same snapshot.

**Why:** the question isn't just "is Jev right?" but "is Jev better than rules that take no time
to compute?" Without them, results can't be judged. The report goes one step further and shows
what's left of Jev's score once the rules are accounted for, because Jev reads the same numbers
the rules are built from and could simply be repeating them. On 31 minutes of recorded data that
is what we found: Jev scored about half as well as plain book imbalance, and nothing of its score
was left once the rules were accounted for ([model.md](model.md#what-jev-has-shown-on-market-data-so-far)).

## D14. Backtests ask about many moments at once, and pretend the answers came late

**Chosen:** backtests ask Jev about many recorded moments in parallel, then score each answer as
if it had arrived a set delay later.

**Why:** whether Jev sees anything doesn't depend on speed, and asking about past moments in
parallel gives thousands of answers quickly. The delay is then applied honestly when scoring.

## D15. Keep the full order book, sorted with the best price last

**Chosen:** the book keeps every price level, in sorted lists with the best price at the end.

**Why:** almost all changes happen near the best price, and changes at the end of a list are
quick. This made each update about six times faster. The whole book is kept because distant
price levels become important when the market moves.

## D16. Leave the "microprice" out of Jev's text

**Chosen:** the microprice is calculated but not shown to Jev.

**Why:** Bitcoin's bid and ask on Coinbase are almost always one cent apart, and then the
microprice adds nothing that book imbalance doesn't already say. **Rethink** for markets where
the bid and ask are usually further apart.

## D17. Show the time to the minute only

**Chosen:** Jev's text shows times like `05:56 UTC`, not milliseconds.

**Why:** a millisecond timestamp would make every text different from the last without adding
anything useful, and Jev's answers shift a little whenever its input changes.

## D18. Settings come from environment variables

**Chosen:** every setting is read in `src/config.ts` from environment variables, with defaults,
and checked at startup.

**Why:** it works the same in a terminal, a service, or another machine, with no config file
format to learn. Checking at startup means a typo stops the program with a clear message instead
of quietly doing something else. **Rethink** if settings get complicated enough to need a proper
config file.

## D19. Save everything as JSON Lines

**Chosen:** one JSON record per line; saved market data is also compressed.

**Why:** these files can be appended to as things happen, survive a crash up to the last line,
and open easily in other tools. Only market data is compressed, because it's large; decision files
are left readable.

## D20. Read public news feeds politely, and as often as that allows

**Chosen:** the feed reader asks sites only for changes, adds a little random timing, backs off
after errors, skips feeds that block automated readers, and ignores whatever was already in a
feed at startup. A feed that can answer "nothing changed" with an empty reply is checked every
10 seconds; one that sends everything each time, every 30. The SEC's filing list is checked
every 10 seconds regardless.

**Why:** free public feeds are enough to test whether Jev can tell which news matters, and being
a good citizen keeps them available. An empty "nothing changed" reply costs a site almost
nothing, so asking often is fair, and it cuts the average wait to notice news from 15 seconds to
5. The SEC allows up to 10 requests a second, and filings move prices within minutes. Ignoring
the startup backlog stops a restart from treating old stories as new.

## D21. News waits for Jev; market snapshots don't

**Chosen:** when Jev's rate limit is hit, a news item waits (up to 5 minutes) and is retried. A
refused market-data question is simply dropped.

**Why:** market snapshots are interchangeable, and the next one is fresher anyway. News items are
rare, each one is a data point, and a slightly late answer still tells us something over a
30-minute window.

## D22. News and market data run as separate programs

**Chosen:** `npm run news` and `npm run live` are separate programs.

**Why:** they can be started and stopped independently, and on an account without credits they
don't compete for the few Jev calls allowed.

## D23. Count separate pieces of evidence, not decisions

**Chosen:** the reports' confidence scores count only decisions that are at least one full
horizon apart, walking through them in time order. For news, that's done per asset.

**Why:** decisions a fraction of a second apart look at nearly the same future. Counting each one
separately made early results look far more certain than they were. Dividing the run's length by
the horizon (the first fix) was still too generous whenever decisions came in bursts, which is
what a rate limit produces: ten decisions in two bursts are two pieces of evidence, not thirty.

## D24. Ship a practice model

**Chosen:** `JEV_PROVIDER=mock` gives random answers after a realistic delay.

**Why:** it lets anyone run the whole pipeline for free, and it tests the reports: random answers
must score about zero. They did, which shows the reports don't accidentally look at future prices.

## D25. External data only through official access

**Chosen:** outside data comes only from official APIs and feeds that allow automated reading:
public news feeds, the SEC, Alpaca, and X's API.

**Why:** official sources are stable, have clear limits and prices, and there's no question about
whether we're allowed to use what we collect.

## D26. One Jev call per news item, covering all its assets

**Chosen:** a news item that concerns several assets gets one call with questions for each asset,
plus one shared "is this new?" question.

**Why:** Jev answers questions at the same time, so a second asset costs a little extra text but
no extra time and no extra rate-limit use. Whether an item is new doesn't depend on the asset, so
it's asked once.

## D27. Switch stock prices on only when needed (except SPY)

**Chosen:** a stock's live prices are switched on when news about it arrives and off after its
last check. When it's switched on, its latest price, last close, and last 40 minutes of prices
are fetched at once. SPY, which stands for the whole market, stays on permanently. We stay on
Alpaca's free plan.

**Why:** the free plan allows only 30 stocks at a time, which is enough if we watch only the
stocks in the news. Fetching recent prices up front means Jev can be told what a stock has been
doing from the very first item about it. SPY is needed for every general news item, so keeping
it on costs one slot and gives it continuous history; it also gives the connection something to
confirm every 30 seconds, so a connection that died while idle is noticed before it's needed.

## D28. Let the source decide which assets a news item is about

**Chosen:** we use the tags each source provides. Items without tags count as general market news
(SPY and Bitcoin). Items tagged only with things we can't price are skipped. At most 3 assets per
item. One exception: in cashtags typed by people (X posts, typed headlines), well-known crypto
symbols other than Bitcoin count as "can't price".

**Why:** the source knows best what its story is about; guessing tickers from text would add
mistakes. The cap stops "10 stocks to watch" roundups from using up our limits. The exception
exists because `$ETH` and `$SOL` are also real stock tickers, and a person writing `$SOL` almost
never means the stock.

## D29. Secrets live in a gitignored `.env`, loaded by Node

**Chosen:** all API keys, including the gateway key, are kept in `.env`, which is private (only
readable by you) and never committed. Every npm script loads it.

**Why:** the project then runs the same from any terminal, as a background service, or on another
machine such as a Raspberry Pi. Settings already in your shell take priority, so a server can
provide its own.

## D30. A stock's price only counts when its bid and ask are close together

**Chosen:** Jev sees each stock's bid/ask spread. The engine doesn't ask about a stock whose
spread is over 0.5%. The report counts a price move only if the spread was under 0.5% both when
Jev answered and at the later moment being checked.

**Why:** outside trading hours, free stock prices can be several percent apart. The midpoint of
prices that far apart isn't a real price. Checking both ends matters because a story at 3:50 pm
has its 30-minute check after the close, when a thin quote's midpoint can sit far from the last
real price and look like a big move that never happened.

## D31. Read X with one search over a short list of official accounts, on a budget

**Chosen:** every 10 seconds, one search covers all chosen accounts. It reads only new posts,
skips retweets and replies, stops for the day at a set number of posts, and never asks for
account profiles alongside posts. The accounts' ids are looked up once and saved.

**Why:** X charges for each post it returns and twice as much for each profile, but nothing for a
search that finds nothing. So searching often is free and cuts the wait to notice a post, while
attaching profiles to every search could cost more than the posts. Official accounts are where
important announcements appear first. **Rethink** if speed from X becomes more important than
cost; X's real-time stream would be faster.

## D32. On a Raspberry Pi, run as a systemd service

**Chosen:** `deploy/pi/setup.sh` installs the pipeline as a systemd service (`jev-hft@news-live`,
or `record` / `live`). It starts at boot after the clock syncs, restarts after crashes and once a
week, and may only write to the project's `data/` folder.

**Why:** systemd comes with Raspberry Pi OS, so nothing extra is needed to keep the pipeline
running unattended, and its logs are kept in the system journal. Waiting for the clock matters
because every recorded time depends on it. Stopping sends the same signal as Ctrl-C, so pending
records are saved before it exits.

## D33. Keep Jev's connection open

**Chosen:** calls to Jev use their own connection settings (idle connections kept 25 seconds),
and a tiny request every 20 seconds keeps one connection open at all times.

**Why:** Node closes a connection after 4 idle seconds, and opening a new encrypted one costs
about 100 ms. News calls are minutes apart, so every news decision was paying that. With this,
news decisions 25 seconds apart took 255 to 300 ms instead of 460 to 550. The tiny request
carries no key and reaches no model, so it costs nothing. It only affects Jev's connection.

## D34. Only ask what can be measured

**Chosen:** before calling Jev about a news item, the engine leaves out stocks whose market is
closed, assets without a usable price right now, and near-identical repeats of a recent headline.
If nothing is left, no call is made. The item is still saved.

**Why:** an answer that can never be checked against a price move teaches us nothing, still costs
a call, and on an account without credits uses up one of very few. Asking about the same event
several times also made it count several times in the results. `NEWS_ONLY_TRADABLE=0` switches
the first two filters off for testing.

## D35. Show Jev what has already been reported

**Chosen:** the engine remembers the last 6 hours of headlines. Each item is shown with up to 5
earlier headlines about the same asset, and the "is this new?" question says those are already
known. An item the model never answered about (skipped, or every call failed) still counts as
known, but doesn't make a later report of the same story count as a repeat.

**Why:** Jev can't know whether a headline is news or a follow-up unless it's shown what came
before. With the real model, the same headline scored 0.73 for "new" on its own, 0.33 after two
earlier reports of the same event, and 0.83 after an unrelated one, while its other answers
stayed the same. "Related" is judged by shared tickers and shared words, which is crude but needs
no extra model call.

## D36. Name things in full for Jev

**Chosen:** questions say "Apple Inc. (AAPL)", not "AAPL stock", using the SEC's public company
list, and "the S&P 500 index (SPY ETF)" for SPY. Each source is described in words ("Federal
Reserve press releases (official)") instead of by its short internal name. SEC filing entries are
restated as plain sentences.

**Why:** Jev reads language. A bare ticker may mean nothing to it for a small company, `fed` says
less than "Federal Reserve press releases", and the SEC feed's own wording is written for filing
clerks. The company list loads in the background and is retried if it fails; until it arrives,
bare tickers are used.

## D37. What counts as "flat" follows the market's volatility

**Chosen:** in the market-data questions, "flat" means a move smaller than two typical moves for
that horizon at the current volatility, rounded to 0.1 bp. The thresholds used are saved with
each decision, and the report judges each answer against its own.

**Why:** a fixed threshold suits one kind of market: in a busy one nearly everything counts as up
or down, in a dead one nothing does. For the multiplier we tested half, one, and two typical
moves, and the old fixed thresholds, on the same recorded snapshots. They predicted equally well.
The narrower the band, the more of Jev's answers were pinned at the extremes (23% of 60-second
answers at half a typical move, 1% at two), and an answer that's always extreme ranks nothing. So
the default is the widest one tested. We had expected the opposite, which is why it was tested.
**Rethink** with data from a busier market: the report's calibration section shows Jev's average
answer next to what really happened.

## D38. Ask about the market once a second, not back to back

**Chosen:** the live market-data loop waits at least a second between questions by default.

**Why:** back to back it makes about 2.7 decisions a second, but decisions that close together
look at nearly the same few seconds, and the report counts stretches of time, not decisions
(D23). So most of that spending buys the same information again. Once a second costs about $3 a
day instead of $8, and every decision is just as fresh, because each uses a snapshot taken when
it's sent.

## D39. Pay for each backtest answer once

**Chosen:** backtest answers are saved on disk, filed under exactly what Jev was shown. A backtest
also says what it's about to cost before it starts.

**Why:** the delay we pretend and the way results are scored don't change what Jev was asked, so
trying another delay, fixing the report, or finishing an interrupted run shouldn't cost anything.
The practice model's random answers are never kept.

## D40. During an outage the price is unknown, not unchanged

**Chosen:** from the last good message before a connection problem until data is flowing again,
"what was the price at time t?" answers "unknown", for Bitcoin and for stocks.

**Why:** the old behaviour reported the last price from before the outage, so any check that
landed inside one was recorded as "the price didn't move". That's a made-up number, and the
reports already know to leave unknowns out.

## D41. Every connection has a way to notice it has died

**Chosen:** Coinbase's connection is replaced after 10 seconds of silence (it normally sends a
message every second). Alpaca's connections re-send their current subscriptions every 30 seconds
and are replaced if nothing at all comes back within 10 seconds.

**Why:** a connection can die without the computer noticing, especially on Wi-Fi and home
routers. The program would then look healthy while seeing nothing, possibly for hours. Alpaca's
streams are legitimately silent at night and on weekends, so silence alone proves nothing there;
re-sending a subscription is a valid message that always gets a reply.

## D42. Records carry a format version

**Chosen:** every record has `v: 2`. Files from before versions existed have none, and the reports
read both.

**Why:** records gained fields (cost, TypeSafe's share of the time, confidence, thresholds, later
spreads). New fields that old files simply lack are harmless, but the next change might not be,
and a version number is what lets a report tell old from new.

## D43. Tests for the rules that results depend on

**Chosen:** `npm test` runs about 70 tests with Node's built-in runner: no extra packages, no
network, about a second.

**Why:** a broken measurement still produces plausible numbers, so these rules are easy to break
without noticing: no price from the future, unknown is never zero, market hours across daylight
saving, no call when the outcome can't be measured. The news engine takes its clock as a setting
so that time-dependent rules can be tested on any day.

## D44. A live run can save its own input

**Chosen:** `RECORD=1 npm run live` writes the market events it sees to `data/raw/`, the same
format `npm run record` produces, so that run can be replayed later. It's off by default.

**Why:** you can already run both programs side by side, since extra connections to Coinbase's
public feed are free. But two connections don't see quite the same thing: messages land at
different moments, and a gap or reconnect can hit one and not the other. Recording from inside
the live run means the file holds exactly what that run saw, so replaying it reproduces that
run's decisions instead of something close to them. It's off by default because `record` on its
own is free while `live` costs money, so the usual way to gather data for backtests is still to
record without deciding (D14).

## D45. The dashboard is a separate program, fed by messages nobody waits for

**Chosen:** `npm run dashboard` is its own process. The pipeline tells it what's happening
through small UDP messages that need no connection and get no reply. They're prepared after the
pipeline has dealt with any market data already waiting, and the question to Jev is sent before
the dashboard is told about it. Nothing is added to the handling of a market update. What
happened after each decision is read from the result files the pipeline already writes.

**Why:** watching must never cost a decision anything. A web server inside the pipeline would
share its one thread with every browser connected to it, and a slow or broken page could then
delay or crash the thing it's watching. With one-way messages there's nothing to wait for and
nothing that can push back: if the dashboard is slow, stopped, or was never started, the messages
just disappear. Measured side by side on the same market, handling a market update took the same
time with telemetry on as off: the copy with telemetry landed between two identical copies
without it, which differed from each other by more than it differed from either. Noting an event costs about 0.3 millionths of a second.
It's on by default for that reason, and `TELEMETRY=0` removes it entirely.

## D46. The dashboard's page has no framework and no build step

**Chosen:** the page is plain TypeScript with charts drawn by hand on `<canvas>`. The server
blanks out the types as it serves each file, which Node can do itself. The logic for "what does
this message mean" is one file used by both the server and the browser.

**Why:** it keeps the project's rule that what's in the repo is what runs, adds no packages, and
works on a home network or a Raspberry Pi with no internet. One shared piece of state logic means
the server's history and the page's live view can't drift apart. **Rethink** if the page grows
far beyond a monitoring screen; a framework earns its keep with many interacting views, which
this doesn't have.

## D47. Every run's files carry its process number

**Chosen:** output file names end with the time the program started and its process id
(`live-gateway-2026-09-19T05-53-41-719Z-4821.jsonl`).

**Why:** the time alone is only unique to the millisecond. In a side-by-side test three copies
started in the same millisecond, chose the same file, and overwrote each other's records without
any error. The process id makes that impossible.

## D48. The dashboard's profit and loss follows a rule you could have followed

*Trading every lean was changed by D59: a call is now traded only when its track record says it
will pay for itself. Entering at the mid when the answer arrived, and counting unmoved trades
apart, still stand; the fee is D55.*

**Chosen:** every answer with a lean is traded, all the same size, entering at the mid price when
the answer arrived and closing at the horizon. Trading costs nothing unless `FEE_BPS` says
otherwise, and trades where the price finished exactly where it started are counted apart from
the ones that lost.

**Why:** the report's "net edge" sorts a whole run into quintiles and compares the best signals
with the worst. That measures how much the signal knows, but it is not a result you could have
had, because picking the quintiles needs the run to be over. The dashboard answers the plainer
question instead: follow every lean as it arrives, and see where you end up.

Entering at the mid when the answer arrived, rather than at the snapshot, is the same rule the
scoreboard uses: the snapshot price is gone by the time Jev replies. Counting unmoved trades
apart matters more than it sounds, because over two seconds the price usually has not moved at
all: treating those as losses would have shown a 7% success rate where the real figure was 53%.

The zero default is deliberate. Real costs dwarf these moves, so mixing them in hides whether the
signal is worth anything in the first place. Keeping them separate lets you see the signal first
and then charge for trading with `FEE_BPS` to find out what is left.

## D49. A second, filtered strategy sits next to the plain one, not in place of it

*Its gate and its sizing were replaced by D51 a day later, once there was enough data to test
them. The reasoning for showing two rules side by side, and the headline check, still stand.*

**Chosen:** the dashboard now runs two trading rules over the same finished decisions and shows
both: the existing "trade every lean" baseline, and a "filtered" rule that sits a call out unless
a simple, zero-latency signal agrees and no headline from the last 15 minutes disagrees, and sizes
what is left by the strength of Jev's lean and TypeSafe's own reported confidence.

**Why:** the point of adding technical and fundamental factors is to find out whether they help,
which needs a baseline to compare against. Replacing the plain rule with the filtered one would
have hidden that comparison; showing both, computed from the same decisions at the same time,
makes the difference visible on the page instead of asking you to trust that filtering works.

**How the filtered rule works, and why:**
- **Technical confluence:** requires at least one of the four simple rules (order-book imbalance
  at the best level and at five levels, buying-minus-selling flow, and the five-second price
  change) to point the same way as Jev. A rule with no opinion (exactly zero) never counts as
  agreeing. This is deliberately a low bar — one of four, not a majority — because the report
  already found Jev's calls mostly overlap with what these rules say; the goal here is to catch
  the calls that agree with *nothing* measurable, not to second-guess every one.
- **Sizing:** `|P(up) − P(down)| × confidence`, capped at one full-size trade, so a weak or unsure
  lean is still traded but for less, rather than being kept at the same size as every other call
  or dropped entirely. Older records and the practice model have no confidence field; those size
  by the lean alone.
- **Fundamental:** looks at the most recent finished headline about the traded instrument from the
  last 15 minutes, using the same relevance-weighted P(bullish) − P(bearish) signal the news
  pipeline already computes. Agreement adds a fixed, modest boost (25%) rather than an unbounded
  one; disagreement sits the trade out entirely, on the reasoning that a human trader would not
  ignore a fresh, opposing headline just because the order book still looked fine a moment ago. No
  recent headline (the common case — most sources publish only a few times an hour) is neutral,
  not a penalty.
- **No lookahead:** a headline only counts if it was already answered (`tResp`) at or before the
  decision's own snapshot time. Getting this wrong — using a headline before the pipeline could
  actually have known about it — would make the backtest fictitious, so it is covered by its own
  test.

The two rules share one `pnl.ts`, split only by which trades they take and how big; the scoring,
fee handling, and drawing code is identical, so the comparison is never confused by the two paths
computing "profit" two different ways.

## D50. Jev's lean is read against what it usually says, not at face value

**Chosen:** the pipeline keeps Jev's answers from the last 15 minutes and reads each new one
against the middle of them. The result (`signals.jevc_*`) is what gets drawn, scored, and traded.
The plain answer (`signals.jev_*`) and the usual lean it was read against (`lean`) are saved too.
The engine works it out the moment an answer arrives, from earlier answers only.

**Why:** over a nine-hour run the price rose exactly as often as it fell, yet Jev leaned "down"
in more than 80% of its 2- and 10-second answers. Things that are one-sided all day (three sell
trades for every buy, a slightly deeper ask side, a slow drift) read as bearish every second, so
"slightly down" is Jev's neutral. At face value four trades in five were shorts, and an answer
more bullish than usual was still traded short. Read against its usual lean, Jev pointed the
right way 66% of the time at 2 seconds instead of 59%, and made about twice as much per trade.

**Why this, and not something fitted to the results:**
- It never looks at prices. It uses only Jev's own earlier answers, so there is nothing about
  one day's market for it to memorise.
- The one number in it doesn't matter. Windows from 2 to 60 minutes, middle or average, all
  scored within about two points of each other, so 15 minutes was picked from the middle and
  left alone. It is deliberately not a setting.
- It was chosen on the first six hours of the run and checked once on the last three, which it
  had never seen. Every figure quoted here is from those three hours.
- The report prints the same checks for any run, and the dashboard keeps the face-value result
  on screen as a yardstick, so it goes on being tested rather than trusted.

**What it costs:** a run makes no calls for its first minute, while it learns the usual lean. And
one result got worse on purpose. At 60 seconds the face-value rule looked profitable, but only
because it was short nearly all day while the price drifted down; on the flat hours that followed
it lost. Taking the lean out removes that luck along with the bias, and shows the 60-second answer
for what it is: no better than a coin.

**Alternatives passed over:** changing what Jev is shown so the lean never forms (it needs paid
replays to test, and trying several wordings and keeping the best is an easy way to fool
yourself; the correction above adapts to whatever the wording does anyway). Blending Jev with the
order book into one signal, and pooling its three answers (neither beat the simpler pieces).
Fitting weights or a calibration curve to the outcomes (that is exactly what would overfit one
day).

## D51. The selective rule asks the order book to agree, and stakes by the strength of the lean

**Chosen:** the dashboard's second rule now trades the corrected lean only when the best level of
the order book points the same way, and stakes in proportion to how strong the lean is next to
Jev's ordinary one, up to twice the normal stake. The headline check from D49 is unchanged. This
replaces D49's "any one of four rules agrees" gate and its sizing by lean times confidence.

**Why the gate changed:** "any one of four" let through more than nine calls in ten, so it
filtered almost nothing. Best-level book imbalance is the one simple rule that beats Jev at every
horizon, and when it and Jev disagreed, Jev was right only about 45% of the time. A dissent that
is wrong more often than right isn't worth acting on. On the unseen three hours the rule was
right 71% of the time at 2 seconds and 66% at 10, against 62% and 61% for the rule it replaces.

**Why the sizing changed:** TypeSafe's confidence turned out to be the probability of whichever
answer Jev picked (the two rank identically, 0.999). At short horizons that answer is usually
"flat", so D49's rule was staking most when Jev was surest that nothing would happen. The
strength of the corrected lean is a real guide: the weakest fifth of leans was right 55% of the
time and the strongest 74%, rising steadily between. Staking by it made about a fifth more per
unit staked than flat stakes, and it made no difference whether the cap was two or three times
the normal stake, so the more cautious one was kept.

**Why stakes are measured against Jev's ordinary lean:** so an ordinary lean is one normal stake
and the two cards put down about the same amount in all. D49's rule staked about a quarter as
much per trade, and its smaller total was read as the rule doing worse when it was only betting
less. "Average per stake" is now worked out per unit staked for the same reason.

**What to keep in mind:** most of this rule's accuracy is the order book's. The book alone is
right about two times in three at 2 seconds; Jev's agreement adds a few points. That is an honest
measure of what Jev contributes on market data, and it matches everything else found so far.

## D52. Jev is called directly, not through the gateway

**Chosen:** `JEV_PROVIDER` now defaults to `typesafe`, so every call goes straight to TypeSafe's
own API with `TYPESAFE_AI_API_KEY`. The gateway route stays in the code, is still tested, and is
still benchmarked beside the direct one.

**Why:** it halves the wait. Measured on the same questions from the same machine, interleaved a
minute apart: **122 ms against 255 ms**, and in the live pipeline a decision's round trip fell
from about 260 ms to about 130 ms. Most of what the gateway added was geography, not work — it
runs in Cleveland and we are in California, so each question crossed the country twice for
nothing. This was the single biggest delay in the whole chain, and the only one we could remove
(Coinbase's own 47 to 85 ms of batching is not ours to change).

**What we gave up, and what we did about it:**

- **The gateway priced every call.** TypeSafe's API doesn't, so a call's cost is now worked out
  from its tokens at `JEV_USD_PER_MTOK`, default $0.042 per million input tokens. That rate
  reproduces the gateway's own figures to the cent over the 30,000 calls we have, but it is our
  arithmetic against their list price, not a bill. If TypeSafe charges differently, one setting
  fixes every report.
- **One key and one bill across providers.** Only Jev is used here, so there was little to lose.

**What we gained beyond speed:** TypeSafe names the build that answered (`jev-1.13.0`), which the
gateway never did. That now goes in every record and prints at the top of the reports, so a run
from one day can be compared with another knowing whether the model changed underneath. It also
reports its own service time in a header, which is a cleaner measure of Jev's thinking than the
gateway's figure ever was: the gateway timed TypeSafe from Cleveland, so its number always had a
leg of network inside it.

**Why the gateway route stays:** it is the only way to compare the two, and the comparison is the
evidence for this decision. Keeping both also means a bad day at either one is a setting away
from being worked around. `npm run bench` runs both by default and prints them side by side, so
the claim above can be rechecked whenever the network or either service changes.

## D53. Which of Jev's calls get a marker is decided by their time, not their place in the list

**Chosen:** the price chart marks the first call in each slice of a few seconds, worked out from
the call's own timestamp (`sliceAt` in `src/dashboard/web/charts.ts`). It used to mark every
*n*th call by counting along the list.

**Why:** the list is a window that slides. Every second the oldest call drops off the front, so
every remaining call's position shifts by one, and "every 4th by position" then lands on an
entirely different set. Replaying the live data, **67% of the triangles on screen were replaced
every second**, and the count jumped whenever the window's length crossed a multiple of 260 and
changed the spacing. Deciding by time fixes both: a call's slice never changes, so markers stay
where they are and scroll off the edge instead of flickering.

**Why it only showed up now:** the bug was always there, but until D50 Jev leaned "down" in more
than 80% of its answers, so reshuffling swapped red triangles for other red triangles and looked
like nothing. Once the calls were read against Jev's usual lean they split roughly evenly between
up and down, and every reshuffle became a visible flash of colour across the whole chart. A
cosmetic fault hidden by a data fault.

**How it is kept fixed:** `test/charts.test.ts` slides a window across 40 minutes of calls and
fails if any marker that is still on screen is dropped or swapped. The first version of that test
passed against the old code, because its data was shorter than the window so nothing ever left
it — the fixture was lengthened until the old rule failed on all 300 seconds it checks. A test
for a sliding window has to actually slide.

## D54. The 10 s and 60 s calls come from a small model of the order book, not from Jev

**Chosen:** every decision now also records the expected move over 10 and 60 seconds from a
linear fit on six measurements of the book (`ob_10s`, `ob_60s`, src/model/ridge.ts). Its
weights are fitted offline by `research/fit.py` and committed in `src/model/weights/`, so the Pi
runs exactly what was tested. Jev is still asked, and still scored.

**Why:** over four days the Pi recorded, and on a day kept locked until every choice was made,
the model was right 55.7% of the time at 10 seconds and 63.5% on its strongest tenth of calls.
Jev, on the same kind of seconds, was right 52%, and adding it to the model changed nothing. The
model also answers in about 10 µs, costs nothing, and says *how far* it expects the price to move,
which a cost decision needs and a direction alone cannot give ([accuracy.md](accuracy.md)).

**Why only six measurements, and a straight line:** 80 measurements (order flow, trade flow,
momentum, time of day) did no better, and nor did boosted trees. A simpler model is easier to
trust, to run on the Pi, and to check: the test suite holds the live code to the answers Python
gave, to nine decimal places.

**Why it is worked out after Jev's request is sent:** so it cannot delay Jev, and it only reads
the book once per decision, so nothing is added to the handling of each market event.

**When to rethink:** refit every few weeks, or when the scoreboard shows it slipping. If a feed
from another exchange is added (the most likely source of a real 10 to 60 second signal), the
fit should be rerun with it.

## D55. Every trade pays two fees and the spread, and the fee is set per fill

**Chosen:** the reports and the dashboard charge every trade `FEE_BPS_PER_SIDE` twice (once to
open, once to close) plus the spread at the moment it would have been placed
(src/model/costs.ts). The default is 5 bp, Coinbase's lowest published taker fee. It replaces
`FEE_BPS`, a single round-trip number that defaulted to 0; an old `.env` that still sets
`FEE_BPS` keeps the same cost, read as half on each side.

**Why:** exchanges quote their fees per fill, so a per-fill setting is the one people fill in
correctly. A default of zero made every card show what the moves were worth with nothing paid,
which looked like profit and wasn't. At the cheapest taker fee there is, nothing at 10 or 60
seconds survives, and the pipeline should say so without being asked. Each result also keeps
what the moves alone were worth, so a right-but-too-small signal can still be told from a
wrong one.

**When to rethink:** set it to your own tier. If limit orders (maker fees, often 0) are ever
simulated, they need their own cost model: a resting order is not always filled, and tends to be
filled when the price is moving against it.

The default has since become Binance.US's taker fee (D62).

## D56. Running out of credits pauses the engine for minutes

**Chosen:** when TypeSafe says the account has no credits, the market-data engine waits a minute
before asking again, then twice as long each time it is refused, up to 15 minutes. It counts these
apart from other errors (`no-credit` in the status line).

**Why:** from 2026-09-22 20:33 to 2026-09-23 23:24 UTC the account was empty, and the engine kept
asking once a second: 91,729 identical failures in the Pi's log. A rate limit clears in seconds;
an empty account doesn't, so there is nothing to gain from asking every second, and the log
becomes hard to read. The first answer after credits return resets the wait.

## D57. The 10 s rule waits for a calm market; the 60 s rule doesn't

**Chosen:** the dashboard's order-book rule trades a 10 s call only when the last minute was calm
(60-second volatility below the two-thirds mark of the training days, 0.64 bp) and the spread is
one tick. The condition is written into each model's file, so it changes when the model is refit.

**Why:** the model was right more often in those seconds on every test day: 57.5% against 53.2%
in the other seconds on the earlier test days, and 58.2% against 55.7% for the day as a whole on
the locked one (67% on its strongest tenth). With a spread wider than a tick the book said almost
nothing. At 60 seconds the same condition made no
difference, so it isn't applied there.

## D58. Binance.US is recorded next to Coinbase, by a program of its own

**Chosen:** `npm run record:binanceus` (the `jev-hft@record-binanceus` service on the Pi) saves
Binance.US's BTC/USD and BTC/USDT order books and trades, one file per pair, in the same standard
form as the Coinbase recording. It is a separate program from `npm run record`, and each pair has
its own connection.

**Why Binance.US:** it is the one US venue where a small account pays nothing for resting orders
(0% maker, 0.02% taker since April 2026), and the large exchanges whose prices often move first,
Binance's and Bybit's main sites, refuse connections from the US outright. Binance.US's market
makers most likely price off those, so its quotes may carry that information to us. Whether they
move before Coinbase's, or after, is the question the recording is for.

**Why a program of its own:** the Coinbase recorder has run for days, and one exchange's trouble
should never stop or restart the other's recording. The same reasoning gives each pair its own
connection: a book that breaks on one never resets the other.

**What to keep in mind:** Binance.US is small, about $1M of BTC/USD and $3M of BTC/USDT a day in
September 2026, so a $10,000 order is a noticeable share of a day's trading there. It is useful
for what its quotes say, much less as a place to trade size.

## D59. Jev's cards trade a call only when its track record beats the cost

**Chosen:** the dashboard's Jev cards, like the order-book card, trade a call only when it is
expected to catch more than the round trip costs (the fee on both fills and the spread). Jev
doesn't say how far the price will move, so the expectation comes from its track record
(`src/dashboard/track.ts`): the average of what earlier calls of about the same strength caught,
less two standard errors. Only calls that had finished before the new one was made count, from
the last four hours. Strength is the call's conviction (`src/model/lean.ts`), in bands split at
a half, one and two ordinary leans, and a band needs 50 finished calls before it says anything.
Each rule keeps its own record, so the selective card is judged by the calls the book agreed
with. What every call would have made, traded whatever it cost, is still worked out and shown
beside it. After a restart the dashboard reads back about six hours of records, so the record
is as long as if it had never stopped.

**Why:** with the fee charged (D55), trading every call guaranteed a loss: about 3,000 trades an
hour, each catching 0.2 to 0.5 bp against a 10 bp round trip, for some −$29,000 an hour at
$10,000 a trade. That read as the pipeline failing when the calls were as right as ever. The rule
was what was wrong: nobody places a trade they expect to lose on. The order-book card already
weighed each call against its cost, and now Jev's cards do too.

A track record is used because nothing else turns Jev's answer into basis points: its answer is
a set of probabilities for up, flat and down, and its lean is read against its usual one (D50).
The bands are there because stronger leans caught more on every day measured: at 10 s, from 0.04
bp for the weakest band to 0.32 bp for the strongest, over 77 hours of the Pi's calls. The margin
is there because a band's average over a few hours swings with the market. It counts calls that
share an outcome once, because calls a second apart share most of the same move: sixty 60 s calls
in a row are barely more evidence than one. Over the same 77 hours, a one-hour record without the
margin took thousands of 60 s trades at a quarter of a basis point a fill, and lost on them. With
the margin and four hours, it took none at half a basis point a fill or more, and the few it took
at a quarter lost on average. At no fee at all it still trades most 2 and 10 s calls, which made
+0.12 to +0.24 bp each, so it is not simply refusing everything.

**When to rethink:** if fees ever fall to where some calls clear the bar, the four-hour window and
the two-standard-error margin decide how many. Both were chosen on the same 77 hours they are
described with here, so check them on new days first.

## D60. The dashboard hears of a headline when Jev answers it, not when its record is saved

**Chosen:** the dashboard takes each headline's verdict from the news program's `news-answer`
message as it arrives (`src/dashboard/headlines.ts`). Its later prices are filled in from the news
program's once-a-second price as each check comes due, and the saved record replaces it, with its
exact prices, once the news program writes it. Both the selective rule's news check and the news
card (D61) read from this.

**Why:** the news program saves a headline's record only after its 30-minute check, and until
now that was the only way a headline reached the trading rules. So the selective rule's "a
headline from the last 15 minutes leans the other way" could never apply live: by the time a
headline was known to the rules it was already 30 minutes old. It was only ever applied in
hindsight, to decisions near the back of the 50-minute window. News moves prices in its first
minutes, which is exactly the part that was missed.

**Why the news program's own price:** it is the price the news program itself measures the
headline's moves by, so the live figure and the saved one agree to within the second between
ticks. A tick more than two seconds from when a check was due is not used; the check waits for
the saved record instead.

## D61. The news is traded when Jev expects a move bigger than the cost

**Chosen:** the dashboard's fifth card trades each headline about the traded instrument in the
direction Jev leans, from the price when the answer arrived, held 1, 5 or 30 minutes, when the
move Jev expects beats the round trip (two fees and the spread, D55). The expected move is the
chance the news matters, times how much more bullish than bearish it is, times the size Jev's
magnitude answer stands for on the rubric it was asked with (`expectedMoveBps` in
`src/news/questions.ts`: nothing, 10, 60 and 150 bp for Bitcoin's four levels, read in a
straight line between them).

**Why face value and not a track record, as Jev's other cards use (D59):** Jev's answer about a
headline says how far the price could move, which its answer about the order book doesn't, so it
can be weighed against the cost directly, like the order-book model's. And a track record needs
many calls: the Pi saw about 45 headlines about Bitcoin a day, so a four-hour record would hold
eight, and the 50 a band needs would take days. Reading the answer at face value lets the card
act from the first headline and be judged on what follows.

**What to expect:** on the 149 Bitcoin headlines the Pi recorded from 2026-09-20 to 2026-09-24,
the rule would have taken 36. Over 30 minutes 19 went its way and 17 didn't, +108 bp before
costs and −256 bp after (−7 bp a trade). Over 1 and 5 minutes it was a coin flip before costs.
Jev's direction on Bitcoin news has not yet shown any skill: on 62 relevant headlines, the news
report's rank correlation between its lean and the move is within one standard error of zero at
every horizon (`npm run analyze:news`). The card is how skill will show, or not, as headlines
accumulate.

**Why every headline kept and not the last 50 minutes:** the other cards describe the last 50
minutes of a run because they see thousands of calls in that time. News is too rare for that, so
the card keeps the last 500 headlines and reads earlier runs' files back on a restart.

**When to rethink:** once a few hundred headlines have been traded, compare what each size of
expectation actually caught with what it promised. If the promises run high, the sizes in
`expectedMoveBps` are too generous, and a track record by band (as D59) would be the fairer
judge. The slowest sources also deserve a look: Cointelegraph's items arrived about seven minutes
after their stated publication time, and CoinDesk's about forty seconds, by which time much of a
move may be gone ([news.md](news.md#sources)).

## D62. Trading costs are Binance.US's, where the trades would be placed

**Chosen:** `FEE_BPS_PER_SIDE` defaults to 2, Binance.US's taker fee on BTC/USD and BTC/USDT,
in place of Coinbase's cheapest taker fee of 5.

**Why:** trades would be placed on Binance.US, so its costs are the ones that matter. Coinbase's
fee was the default only because Coinbase was the one exchange the pipeline knew when the fee was
first charged (D55); recording Binance.US (D58) was about whether its prices move first, and the
cost was never revisited.

**The facts, checked 2026-09-25:** Binance.US charges 0% to makers and 0.02% to takers on every
pair since 2026-04-22, dropping to 0.01% only above $500M of trading a month; only BNB/USD is
cheaper
([its fee page](https://www.binance.us/fees)). Its spread, over 20 hours of the Pi's recordings,
was a median 0.01 bp on BTC/USD and 0.03 bp on BTC/USDT, under 0.2 bp nine times in ten. Its best
ask held a median of about $215 on BTC/USD, and a $100 order cost a median 0.005 bp more than the
mid (0.19 bp at the ninetieth percentile). So a taker's round trip is about 4 bp, almost all of it
fees.

**What is still Coinbase's:** the prices. Every move is measured on Coinbase's mid, and the spread
charged is Coinbase's at the time, about 0.001 bp, against Binance.US's 0.01 to 0.2. Both
differences are under a fifth of a basis point, small next to 4 bp of fees. Binance.US's price
follows Coinbase's closely over minutes, less so over seconds, so the 10 s cards describe
Binance.US least exactly.

**What it changes:** the news card's bar drops from about 10 bp to about 4, so it trades more
headlines. The market-data cards still take almost nothing: their best calls expect well under a
basis point.

**When to rethink:** if orders rest on the book instead (0% there), costs fall to the spread, but
a resting order is not always filled and tends to fill when the price moves against it, which
needs its own model. If the moves themselves are to be Binance.US's, the pipeline has to price
from its recording too.
