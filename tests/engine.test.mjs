// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  makeScheduler, ratingFor, shuffleChoices, applyAnswer, statusOf, buildSession,
  pickNew, requeue, progressBySubelement, refLinks, newIntroducedToday, groupOf, subelementOf,
} from '../js/engine.js';
import { Rating } from '../vendor/ts-fsrs.mjs';

const tech = JSON.parse(readFileSync(new URL('../pools/technician-2026-2030.json', import.meta.url)));
const manifest = JSON.parse(readFileSync(new URL('../pools/pools.json', import.meta.url)));
const sched = makeScheduler();
const DAY = 864e5;

test('only a sure correct answer counts as Good', () => {
  assert.equal(ratingFor(true, true), Rating.Good);
  assert.equal(ratingFor(true, false), Rating.Again);
  assert.equal(ratingFor(false, true), Rating.Again);
  assert.equal(ratingFor(false, false), Rating.Again);
});

test('shuffling keeps every answer once and pins "All these choices are correct" last', () => {
  const q = tech.find(x => x.answers[3] === 'All these choices are correct');
  for (let i = 0; i < 50; i++) {
    const c = shuffleChoices(q);
    assert.deepEqual(c.map(x => x.index).sort(), [0, 1, 2, 3]);
    assert.equal(c[3].text, 'All these choices are correct');
  }
  const plain = tech.find(x => !/these (choices|answers)/i.test(x.answers.join()));
  const firsts = new Set(Array.from({ length: 200 }, () => shuffleChoices(plain)[0].index));
  assert.equal(firsts.size, 4, 'every answer should sometimes come first');
});

test('a sure correct answer schedules the next review later than a miss', () => {
  const now = new Date('2026-12-01T12:00:00');
  const good = applyAnswer(sched, undefined, { correct: true, sure: true, now });
  const miss = applyAnswer(sched, undefined, { correct: false, sure: true, now });
  assert.ok(good.card.due > miss.card.due);
  assert.equal(good.history.length, 1);
  assert.equal(typeof good.card.due, 'number');
});

test('learned needs sure correct answers on two different days', () => {
  const d1 = new Date('2026-12-01T12:00:00');
  let r = applyAnswer(sched, undefined, { correct: true, sure: true, now: d1 });
  assert.equal(statusOf(r), 'learning');
  r = applyAnswer(sched, r, { correct: true, sure: true, now: new Date(+d1 + 60e3) });
  assert.equal(statusOf(r), 'learning', 'same day twice is not enough');
  r = applyAnswer(sched, r, { correct: true, sure: true, now: new Date(+d1 + 2 * DAY) });
  assert.equal(statusOf(r), 'learned');
  r = applyAnswer(sched, r, { correct: true, sure: false, now: new Date(+d1 + 5 * DAY) });
  assert.equal(statusOf(r), 'learning', 'a guess drops it back');
  assert.equal(statusOf(undefined), 'new');
});

test('a fresh session is all new questions, spread across groups', () => {
  const s = buildSession(tech, {}, { newPerDay: 20, sessionSize: 30 });
  assert.equal(s.questions.length, 20);
  assert.equal(s.dueCount, 0);
  assert.equal(new Set(s.questions.map(q => groupOf(q.id))).size, 20, 'one per group before any repeats');
});

test('new questions cover every group before doubling up', () => {
  const picked = pickNew(tech, {}, 40);
  const counts = {};
  for (const q of picked) counts[groupOf(q.id)] = (counts[groupOf(q.id)] || 0) + 1;
  assert.equal(Object.keys(counts).length, 35);
  assert.ok(Object.values(counts).every(n => n <= 2));
});

test('due reviews come before new questions and the daily new limit holds', () => {
  const now = new Date('2026-12-05T12:00:00');
  const records = {};
  for (const q of tech.slice(0, 25)) {
    records[q.id] = applyAnswer(sched, undefined, { correct: false, sure: true, now: new Date(+now - 3 * DAY) });
  }
  const s = buildSession(tech, records, { now, newPerDay: 20, sessionSize: 30 });
  assert.equal(s.dueCount, 25);
  assert.equal(s.newCount, 5);
  // Introduce 20 today, then the next session gets no new questions.
  const today = { ...records };
  for (const q of tech.slice(100, 120)) today[q.id] = applyAnswer(sched, undefined, { correct: true, sure: true, now });
  assert.equal(newIntroducedToday(today, now), 20);
  const s2 = buildSession(tech, today, { now, newPerDay: 20, sessionSize: 30 });
  assert.equal(s2.newCount, 0);
});

test('sessions rarely put the same subelement back to back', () => {
  let adjacent = 0, pairs = 0;
  for (let i = 0; i < 30; i++) {
    const s = buildSession(tech, {}, { newPerDay: 30, sessionSize: 30 }).questions;
    for (let k = 1; k < s.length; k++, pairs++) if (subelementOf(s[k].id) === subelementOf(s[k - 1].id)) adjacent++;
  }
  assert.ok(adjacent / pairs < 0.05, `adjacent rate ${adjacent / pairs}`);
});

test('a missed question comes back a few places later', () => {
  const q = requeue(['a', 'b', 'c', 'd', 'e', 'f'], 'X', { gap: 4 });
  assert.equal(q.indexOf('X'), 4);
  assert.deepEqual(requeue(['a'], 'X', { gap: 4 }), ['a', 'X']);
});

test('progress by subelement adds up to the pool', () => {
  const p = progressBySubelement(tech, {}, manifest.pools[0].subelements);
  assert.equal(p.reduce((n, s) => n + s.total, 0), 409);
  assert.equal(p.reduce((n, s) => n + s.new, 0), 409);
});

test('rule references turn into eCFR links', () => {
  assert.deepEqual(refLinks('[97.301(e), 97.305]').map(l => l.label), ['§97.301', '§97.305']);
  assert.equal(refLinks('[97.1]')[0].url, 'https://www.ecfr.gov/current/title-47/section-97.1');
  assert.deepEqual(refLinks('[1.1307(1)(b)(3)(i)(A)]').map(l => l.label), ['§1.1307']);
  assert.deepEqual(refLinks(''), []);
});
