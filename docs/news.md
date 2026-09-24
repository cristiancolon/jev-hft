# The news path

Code: `src/news/`, `src/news-live.ts`, `src/analyze-news.ts`. Run it with `npm run news`.

## What it does

It collects news as it's published, works out which assets each item is about (Bitcoin, a US
stock, or the market as a whole), asks Jev what the news means for each of them, and records
what the prices did over the next 30 minutes.

**Why a news path at all?** Over a few seconds, prices barely move, so trading fees eat any
edge. News can move prices a lot, and judging news takes understanding language, which is
what Jev is good at.

**Why stocks as well as Bitcoin?** Company news clearly belongs to one company, there's a lot of
it every trading day, and stocks often react strongly to their own news. That makes it easier to
learn whether Jev's judgments are any good.

## Step by step

1. A source delivers a news item. It's saved right away to `data/news/items-<time>.jsonl`.
2. The pipeline decides which assets the item is about.
3. If it's a repeat of a headline from the last half hour, it stops here.
4. Assets whose market is closed are set aside. For the rest, it switches on live prices.
5. Assets without a usable price right now are set aside too. If none are left, it stops here.
6. It builds what Jev sees: the headline, a summary, how old the item is, what each asset's price
   has been doing, and earlier headlines about the same thing.
7. It asks Jev all its questions in one call.
8. Thirty minutes later it writes one record per asset, with the prices at 10 seconds, 30
   seconds, 1 minute, 5 minutes, 15 minutes, and 30 minutes after the answer.

## Only ask what can be measured

A Jev answer is only worth having if we can later check it against what the price did. So before
asking, the engine leaves out:

- **Stocks while the US market is closed** (nights and weekends). Nothing trades, so there's
  nothing to measure. Bitcoin is never closed.
- **Assets without a usable price right now:** no quote at all, a quote whose bid and ask are more
  than 0.5% apart (`MAX_SPREAD_BPS`, the same limit the report uses), or a stock we can't follow
  because all 30 live-price slots are taken.
- **Near-identical repeats** of a headline seen in the last 30 minutes about the same asset. The
  same story often arrives from two sources, or twice from one.

An item about several assets is asked about only for the ones that pass. If none pass, no call is
made at all. Every item is still saved to the items file, and the status line counts each reason.

**Why:** the old behaviour asked about everything and let the report throw the unusable records
away afterwards. That cost a call each time, and on an account without credits it used up the few
calls allowed. It also counted one event several times when several sources covered it. None of
the records it produced could be scored, so nothing is lost.

`NEWS_ONLY_TRADABLE=0` turns the first two filters off. That's useful for trying the stock side
on a weekend.

## Sources

| Source | How it arrives | How we know the asset |
|---|---|---|
| Public news feeds (`rss.ts`): Federal Reserve, CFTC, Coinbase status page, CoinDesk, Cointelegraph | checked every 10 or 30 seconds | each feed has fixed assets in the settings |
| Benzinga newswire through Alpaca (`alpaca.ts`) | pushed to us the moment it's published | Benzinga tags stories with tickers |
| SEC 8-K filings (`edgar.ts`) | checked every 10 seconds | the SEC's own company-to-ticker list |
| Official X accounts (`x.ts`) | searched every 10 seconds through X's official API | `$TICKER` cashtags in the post |
| Typed headlines (`manual.ts`) | typed into the terminal, for testing | `$AAPL` or `$BTC` in the text |

**Why several sources?** Each covers different news. Newswires cover companies and markets,
the SEC covers official company filings, and agencies post their own announcements. Every
source hands the rest of the pipeline the same kind of news item, so adding or removing one
doesn't affect anything else. Each item also carries a plain description of where it came from
("Federal Reserve press releases (official)", "X post by @SECGov"), which is what Jev is shown
instead of a short internal name like `fed`.

**Why we're polite to websites.** The feed reader asks each site only for what changed, spaces
out its checks, backs off when a site has trouble, and skips feeds that block automated readers.
It also ignores everything already in a feed when it starts, so a restart doesn't treat old
stories as new.

**How often a feed is checked depends on what a check costs the site.** A feed that can answer
"nothing has changed" sends back an empty reply in about 25 ms, so it's checked every 10 seconds
(`NEWS_FAST_POLL_S`). A feed that sends its whole content every time is checked every 30 seconds
(`NEWS_POLL_S`). The reader works out which kind a feed is from its replies. The SEC's filing
list is the one feed checked every 10 seconds even though it sends everything, because filings
move prices within minutes and the SEC allows far more requests than that
([latency.md](latency.md#noticing-news)).

**Benzinga** comes with the free Alpaca account and is our fastest source, because stories are
pushed to us instead of us checking on a timer.

**SEC filings** tell us *what kind* of event a company reported (for example "entered a material
agreement"), not the details. So Jev can judge whether it matters, but rarely which way. The
feed's own wording is written for filing clerks (`8-K - CISCO SYSTEMS, INC. (0000858877)
(Filer)`, followed by a file size), so each entry is restated as a plain sentence: "CISCO
SYSTEMS, INC. (CSCO) filed an 8-K report with the SEC: Results of Operations and Financial
Condition". Reading the attached press release would be a good next improvement. SEC feeds need
your name and email in `NEWS_USER_AGENT`; the SEC asks automated readers to identify themselves.

**X** posts come from a short list of official accounts you choose (`X_ACCOUNTS`). The defaults
are the Federal Reserve, SEC, CFTC, Treasury, Bureau of Labor Statistics, and Coinbase. X charges
for each post it returns ($0.005) and twice that for each account profile ($0.010), but nothing
for a search that finds nothing. So the reader searches often, only asks for new posts, skips
retweets and replies, stops for the day after a budget you set (`X_MAX_POSTS_PER_DAY`, default
500 posts, about $2.50 at most), and never asks for profiles alongside posts. It looks the
accounts' ids up once, saves them in `data/cache/x-users.json`, and recognizes authors from that.

## Which assets an item is about

- If the source tagged it, we use those tags (up to 3; stories with many tags are usually
  roundups).
- If it has no tags, it's treated as general market news: the SPY fund (standing in for the US
  stock market) and Bitcoin.
- If its tags are all things we can't price, it's skipped.

**Why trust the source's tags?** The source knows best what its story is about. Guessing tickers
from the text would add mistakes.

**One exception: cashtags typed by people.** On X, `$ETH` and `$SOL` mean cryptocurrencies, but
those letters are also real US stock tickers. A publisher's tag "ETH" means the stock; a person's
"$ETH" almost never does. So for X posts and typed headlines, well-known crypto symbols other
than Bitcoin count as "something we can't price" instead of being matched to an unrelated stock.

## Prices

Bitcoin prices come from Coinbase, which is always connected. Stock prices come from Alpaca.

We use Alpaca's **free plan**, which gives live prices for up to 30 stocks at a time from one
exchange (IEX). So a stock is switched on only when news about it arrives, and switched off
once its 30-minute check is done. When a stock is switched on, we fetch its latest price, its
last closing price, and its last 40 minutes of one-minute prices, all at once
([feed.md](feed.md#stock-prices-from-alpaca-alpacats-alpaca-stocksts)).

- **Over the 30-stock limit,** extra stocks can't be watched, so they aren't asked about.
- **Outside regular trading hours,** free stock prices can be far apart: on a Saturday, AAPL's bid
  and ask were 0.33% apart and SPY's 6%. A midpoint of prices that far apart isn't a real price.
  Jev is shown each stock's spread, stocks with a spread over 0.5% aren't asked about, and the
  report checks the spread again at every later price it uses.
- **If either price connection drops,** prices during the outage are recorded as unknown, not as
  "unchanged" ([market.md](market.md#while-the-feed-is-broken-the-price-is-unknown)).

**Not handled:** trading halts. A stock halted for news shows its last price until it reopens, so
its early checks read as "no move". With the free data we can't see halts.

## What Jev is shown

```json
{
  "headline": "Apple raises full-year revenue guidance above analyst estimates",
  "source": "Benzinga newswire",
  "published": "2026-09-21T14:05Z",
  "minutes_since_published": 0,
  "markets": {
    "AAPL": "Apple Inc. (AAPL) 336.11 (quote spread 2bp), US session regular; change since last close +0.42%, over last 1m +1.5bp, 5m +3.0bp, 30m -7.1bp"
  },
  "earlier_related_headlines": [
    { "minutes_ago": 12, "source": "Benzinga newswire", "headline": "Apple to report earnings after the bell" }
  ]
}
```

- **Full names, not bare tickers.** "Apple Inc. (AAPL)" comes from the SEC's public company list,
  which is downloaded once at startup (and retried in the background if that fails). SPY is
  described as "the S&P 500 index (SPY ETF)", because it's there to stand for the whole market.
  Without the list, a ticker is shown as "AAPL stock".
- **What the price has been doing,** so Jev can judge whether the news already seems priced in. A
  stock that's already up 12% since yesterday's close is the clearest sign of that. For stocks
  this works from the first moment, because recent prices are fetched when the stock is switched
  on.
- **Earlier headlines about the same thing** from the last 6 hours, up to 5. Without them Jev
  can't know whether a headline is news or a follow-up. We checked this with the real model: a
  headline on its own got "is this new?" 0.73; the same headline shown after two earlier reports
  of the same event got 0.33; shown after one unrelated earlier headline, 0.83. Its answers
  about relevance and direction didn't change. "Related" means sharing a company ticker, or, for
  broad assets like Bitcoin, sharing enough words.

## What Jev is asked

For each asset:

- **Relevant?** Could this plausibly move the price within the next 30 minutes?
- **Direction?** Bullish, bearish, or neutral.
- **How big?** Four levels, from negligible to large. Stocks get a wider scale than Bitcoin,
  because they usually move more on their own news.

And once per item: **Is this new information**, or a recap of something already known?

**Why "30 minutes"?** That's the longest check the pipeline makes afterwards. The wording is built
from that setting, so Jev is always judged against exactly what it was asked.

**Why one call per item?** Jev answers all its questions at the same time, so asking about two
assets takes no longer than one. The text is counted once however many questions are asked about
it, so it's cheaper too.

The number used as the directional signal is: chance it's relevant × (chance it's bullish −
chance it's bearish). That keeps irrelevant items near zero even when they sound dramatic. The
report also tries other combinations (bringing in novelty, size, and Jev's confidence) so that,
once there's enough data, we can see which one ranks price moves best.

### Checked with the real model

On test headlines we typed in, Jev rated a surprise interest-rate cut as relevant and bullish for
Bitcoin, an exchange halting withdrawals as relevant and bearish, and a bakery accepting Bitcoin
as irrelevant (0.07). A made-up AAPL guidance raise came back bullish for AAPL, and a made-up
hawkish central bank statement came back bearish for both SPY and Bitcoin. A reworded repeat of a
story 25 seconds later was marked as not new (0.39, against 0.80 for the first). This shows the
questions are understood as intended; it doesn't show the answers make money. Those test outputs
are kept in `data/test/`, away from real data.

## What the dashboard does with the answers

Each answer about Bitcoin reaches the dashboard the moment Jev gives it, and two of its trading
rules act on it straight away. The selective rule sits out Jev's second-by-second calls that a
headline from the last 15 minutes disagrees with, and the news card trades the headline itself
when the move Jev expects beats the cost of a round trip ([dashboard.md](dashboard.md),
[decisions.md](decisions.md#d60-the-dashboard-hears-of-a-headline-when-jev-answers-it-not-when-its-record-is-saved)).
Neither waits for the record this program saves half an hour later.

**How quickly Bitcoin news arrives** varies a lot by source. Over 2026-09-21 to 24, half of the
items arrived within this long of their stated publication time: Benzinga at once (pushed to us),
Coinbase's status page and X posts in about 15 to 20 seconds, CoinDesk in 39 seconds, and
Cointelegraph in about 7 minutes, whose feed evidently lags its own site. Stated publication
times are often rounded to the minute, so treat these as rough.

## When a call fails or there's too much news

- **Rate limit reached:** the item goes back in line, in order of arrival, and the engine pauses
  (5 seconds, doubling up to a minute). Several refusals at the same moment count as one.
- **A passing failure** (a timeout, a network problem, an error on the server's side): the item is
  tried again after 2 seconds, then 4, for at most three calls in all. We saw the gateway time
  out on an otherwise healthy day, and before this the item was simply lost.
- **A request the server rejects outright** (a bad key, a malformed request) isn't retried; it
  would fail the same way.
- Items still waiting after 5 minutes (`NEWS_MAX_AGE_S`) are dropped and counted.

Up to 4 items are judged at the same time (`NEWS_MAX_INFLIGHT`), so a burst of news doesn't queue
behind one call. A news answer is given 5 seconds (`NEWS_TIMEOUT_MS`) rather than the market-data
path's 2, because a slightly late answer is still useful when we measure over 30 minutes.

The engine runs on its own once-a-second tick, not on Coinbase's market data. So stock news keeps
flowing even if the Bitcoin connection is down.

## What's recorded

Each record (`NewsRecord` in `engine.ts`) holds the news item; the asset and, for stocks, the
trading session when the news arrived; the stock's spread; how long each step took, including how
much of Jev's time was TypeSafe itself; how many calls it took; what the call cost; exactly what
Jev saw; Jev's answers and its confidence in them; and the prices when the news was published,
when we got it, when Jev answered, and at each check afterwards. Stock records also keep the
spread at each of those later checks. Records carry a format version (`v: 2`).

## Adding a source

1. Turn the new source's items into the standard news item, stamped with the time their content
   had fully arrived.
2. Give it a plain description of itself for Jev (`sourceLabel`).
3. Tag the assets if the source knows them; leave the tags off for general news.
4. Don't send items that were already published before startup.
5. If it has to check on a timer, use `poller()` from `src/lib/poll.ts`, which handles spacing,
   backing off, and stopping.
6. Add it to `src/news-live.ts`, switched on by `NEWS_SOURCES`.

Use only official APIs and feeds that allow automated reading, and only public information.
