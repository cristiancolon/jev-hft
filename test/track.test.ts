import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectations, MIN_TRACK_CALLS, TrackRecord } from '../src/dashboard/track.ts';
import type { DecisionRecord } from '../src/engine.ts';

const T0 = 1_800_000_000_000;

/** A finished decision `s` seconds after T0: Jev's corrected lean of `lean` against a typical 0.5, the book leaning `book`, the price then moving `moveBp`. */
function rec(s: number, lean: number, moveBp: number, { book = Math.sign(lean), typical = 0.5 } = {}): DecisionRecord {
  const later = 100 * (1 + moveBp / 1e4);
  const fwd = { 1: later, 2: later, 5: later, 10: later, 30: later, 60: later };
  const reading = { usual: 0, typical };
  return {
    v: 2, mode: 'live', provider: 'test', tState: T0 + s * 1000, exchLagMs: 90, buildMs: 0.3, modelMs: 260, tResp: T0 + s * 1000 + 260, state: '',
    probabilities: {} as DecisionRecord['probabilities'],
    lean: { dir_2s: reading, dir_10s: reading, dir_60s: reading },
    signals: { jev_2s: lean, jev_10s: lean, jev_60s: lean, jevc_2s: lean, jevc_10s: lean, jevc_60s: lean, obi1: book },
    midState: 100, midResp: 100, fwdState: fwd, fwdResp: fwd,
  };
}

test("a decision's call is kept for every rule that makes one, with what it caught", () => {
  const track = TrackRecord.from([rec(0, -0.5, 3, { book: 0.4 })]);
  assert.deepEqual(track.calls('corrected', 10).map(c => [c.strength, Math.round(c.caughtBps * 1e6) / 1e6]), [[1, -3]], 'a short that the rise cost 3 bp');
  assert.equal(track.calls('asAnswered', 10).length, 1);
  assert.equal(track.calls('selective', 10).length, 0, 'the book leaned the other way, so the selective rule made no call');
});

test('a call is not kept while its strength is unknown, nor before its horizon has finished', () => {
  const unknown = rec(0, 0.5, 3, { typical: NaN });
  const unfinished = rec(1, 0.5, 3);
  unfinished.fwdResp[60] = null as unknown as number; // how an unfinished horizon comes back from a file
  const track = TrackRecord.from([unknown, unfinished]);
  assert.equal(track.calls('corrected', 10).length, 1, 'only the second, at 10 s');
  assert.equal(track.calls('corrected', 60).length, 0);
});

test('forgetting drops the calls made before the time given, and only those', () => {
  const track = TrackRecord.from([rec(0, 0.5, 1), rec(10, 0.5, 1), rec(20, 0.5, 1)]);
  track.forget(T0 + 10_000);
  assert.deepEqual(track.calls('corrected', 2).map(c => c.t), [T0 + 10_260, T0 + 20_260]);
});

test('a band starts at its lower edge: a lean of exactly half an ordinary one is judged with the stronger calls', () => {
  // Fifty calls at exactly half an ordinary lean (0.25 against a typical 0.5), each catching 2 bp.
  const past = Array.from({ length: MIN_TRACK_CALLS }, (_, k) => rec(k, 0.25, 2));
  const later = [rec(100, 0.3, 0), rec(101, 0.2, 0)];
  const expected = expectations(later, 'corrected', 10, TrackRecord.from([...past, ...later]));
  assert.ok(Math.abs(expected.get(later[0]!)! - 2) < 1e-9, 'a lean of 0.3 is in the same band');
  assert.ok(Number.isNaN(expected.get(later[1]!)), 'a lean of 0.2 is in the band below, with nothing in it');
});

test('no entry where the rule makes no call, and NaN where the call has no strength to go by', () => {
  const none = rec(0, 0, 1);
  const unknown = rec(1, 0.5, 1, { typical: NaN });
  const expected = expectations([none, unknown], 'corrected', 10, new TrackRecord());
  assert.equal(expected.has(none), false);
  assert.ok(Number.isNaN(expected.get(unknown)));
});
