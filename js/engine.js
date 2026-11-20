// Pure study logic: no DOM, no storage. Everything here is unit-tested in tests/engine.test.mjs.
import { fsrs, createEmptyCard, Rating, generatorParameters } from '../vendor/ts-fsrs.mjs';

export const DEFAULTS = Object.freeze({
  newPerDay: 20,      // new questions introduced per day, per pool
  sessionSize: 30,    // questions per session (not counting in-session repeats)
  retention: 0.9,     // FSRS target recall probability
  maxRepeats: 3,      // how many times a missed question can come back in one session
  repeatGap: 4,       // a missed question returns after this many other questions
});

export function makeScheduler(retention = DEFAULTS.retention) {
  return fsrs(generatorParameters({ request_retention: retention, enable_fuzz: true }));
}

export const groupOf = id => id.slice(0, 3);
export const subelementOf = id => id.slice(0, 2);

// ---------- answer handling ----------

// A correct answer only counts if you were sure. A lucky guess is scheduled like a miss,
// so it comes back soon (the hypercorrection / confidence idea from the plan).
export function ratingFor(correct, sure) {
  return correct && sure ? Rating.Good : Rating.Again;
}

const PINNED = /^(all|none of) these (choices|answers)/i;

// Shuffle answer order so you learn the answer, not its position.
// "All these choices are correct" style answers stay last, where they make sense.
export function shuffleChoices(question, rand = Math.random) {
  const items = question.answers.map((text, index) => ({ text, index }));
  const pinned = items.filter(c => PINNED.test(c.text));
  const free = items.filter(c => !PINNED.test(c.text));
  for (let i = free.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [free[i], free[j]] = [free[j], free[i]];
  }
  return [...free, ...pinned];
}

// ---------- card serialization (FSRS cards hold Dates; IndexedDB records hold numbers) ----------

export function toStored(card) {
  return { ...card, due: +card.due, last_review: card.last_review ? +card.last_review : null };
}
export function fromStored(c) {
  return { ...c, due: new Date(c.due), last_review: c.last_review ? new Date(c.last_review) : undefined };
}

// Apply one answer to a record and return the updated record (does not mutate).
// `via` marks answers given in a practice exam ('mock') or right after a lesson ('lesson');
// a question first met that way doesn't use up the daily new-question budget.
export function applyAnswer(scheduler, record, { correct, sure, now = new Date(), via }) {
  const card = record?.card ? fromStored(record.card) : createEmptyCard(now);
  const { card: next } = scheduler.next(card, now, ratingFor(correct, sure));
  return {
    ...record,
    card: toStored(next),
    history: [...(record?.history || []), { t: +now, correct, sure, ...(via && { via }) }],
  };
}

// ---------- status ----------

const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };

// "Learned" = right and sure on at least two different days, and right and sure last time.
// That is successive relearning: one good day is not enough.
export function statusOf(record) {
  if (!record?.history?.length) return 'new';
  const h = record.history;
  const last = h[h.length - 1];
  const goodDays = new Set(h.filter(e => e.correct && e.sure).map(e => dayKey(e.t)));
  return last.correct && last.sure && goodDays.size >= 2 ? 'learned' : 'learning';
}

export function retrievability(scheduler, record, now = new Date()) {
  if (!record?.card) return 0;
  return scheduler.get_retrievability(fromStored(record.card), now, false);
}

// How many questions were seen for the first time today in a study session (counts against
// newPerDay). Questions first met in a practice exam don't use up the daily new budget.
export function newIntroducedToday(records, now = new Date()) {
  const today = dayKey(+now);
  return Object.values(records).filter(r => r.history?.length && !r.history[0].via && !r.history[0].mock && dayKey(r.history[0].t) === today).length;
}

// ---------- session building ----------

// Reviews that are due come first (least-remembered first). New questions fill the rest,
// spread across groups so each session is interleaved, starting with the groups you have
// seen least. The final order is shuffled so subelements are mixed together.
// `allowedGroups` (a Set), when given, limits new questions to groups whose lesson you've read.
export function buildSession(questions, records, { now = new Date(), scheduler, newPerDay = DEFAULTS.newPerDay, sessionSize = DEFAULTS.sessionSize, rand = Math.random, allowedGroups } = {}) {
  const sched = scheduler || makeScheduler();
  const due = questions
    .filter(q => records[q.id]?.card && records[q.id].card.due <= +now)
    .map(q => ({ q, r: retrievability(sched, records[q.id], now) }))
    .sort((a, b) => a.r - b.r)
    .slice(0, sessionSize)
    .map(x => x.q);

  const budget = Math.max(0, newPerDay - newIntroducedToday(records, now));
  const room = Math.max(0, sessionSize - due.length);
  const pool = allowedGroups ? questions.filter(q => allowedGroups.has(groupOf(q.id))) : questions;
  const fresh = pickNew(pool, records, Math.min(budget, room));

  const picked = [...due, ...fresh];
  return { questions: spreadGroups(shuffle(picked, rand)), dueCount: due.length, newCount: fresh.length };
}

export function pickNew(questions, records, count) {
  if (count <= 0) return [];
  const byGroup = new Map();
  for (const q of questions) {
    const g = groupOf(q.id);
    if (!byGroup.has(g)) byGroup.set(g, { seen: 0, unseen: [] });
    const slot = byGroup.get(g);
    if (records[q.id]?.history?.length) slot.seen++; else slot.unseen.push(q);
  }
  const order = [...byGroup.entries()]
    .filter(([, s]) => s.unseen.length)
    .sort((a, b) => a[1].seen - b[1].seen || a[0].localeCompare(b[0]));
  const out = [];
  let round = 0;
  while (out.length < count) {
    let added = false;
    for (const [, s] of order) {
      if (round < s.unseen.length) { out.push(s.unseen[round]); added = true; if (out.length === count) break; }
    }
    if (!added) break;
    round++;
  }
  return out;
}

export function shuffle(list, rand = Math.random) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Nudge the order so two questions from the same subelement rarely sit back to back.
export function spreadGroups(list) {
  const a = [...list];
  for (let i = 1; i < a.length; i++) {
    if (subelementOf(a[i].id) !== subelementOf(a[i - 1].id)) continue;
    const j = a.findIndex((q, k) => k > i && subelementOf(q.id) !== subelementOf(a[i - 1].id));
    if (j > i) [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// In-session queue: a missed question is put back a few places later (retrieval until correct).
export function requeue(queue, question, { gap = DEFAULTS.repeatGap } = {}) {
  const q = [...queue];
  q.splice(Math.min(gap, q.length), 0, question);
  return q;
}

// ---------- progress summaries ----------

export function progressBySubelement(questions, records, subelements) {
  return subelements.map(s => {
    const qs = questions.filter(q => subelementOf(q.id) === s.id);
    const counts = { new: 0, learning: 0, learned: 0 };
    for (const q of qs) counts[statusOf(records[q.id])]++;
    return { ...s, total: qs.length, ...counts };
  });
}

// Pool rule references → links to the eCFR (e.g. "[97.301(e), 97.305]").
export function refLinks(refs) {
  if (!refs) return [];
  const seen = new Set();
  const out = [];
  for (const m of refs.matchAll(/\b(97|1)\.(\d+)/g)) {
    const section = `${m[1]}.${m[2]}`;
    if (seen.has(section)) continue;
    seen.add(section);
    out.push({ label: `§${section}`, url: `https://www.ecfr.gov/current/title-47/section-${section}` });
  }
  return out;
}

// ---------- readiness (Phase 2) ----------

export const GUESS = 0.25;

// Chance of answering one question right on exam day. You always have the 1-in-4 guess;
// on top of that, a question counts as known only if your last answer was right and sure,
// weighted by how likely FSRS thinks you still remember it today.
export function questionOdds(scheduler, record, now = new Date()) {
  const h = record?.history;
  if (!h?.length) return GUESS;
  const last = h[h.length - 1];
  if (!(last.correct && last.sure)) return GUESS;
  return GUESS + (1 - GUESS) * retrievability(scheduler, record, now);
}

// The exam draws one random question from each group, so a group's odds are the
// average odds across its questions.
export function groupOdds(questions, records, scheduler, now = new Date()) {
  const groups = new Map();
  for (const q of questions) {
    const g = groupOf(q.id);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(questionOdds(scheduler, records[q.id], now));
  }
  return [...groups.entries()].map(([group, ps]) => ({ group, p: ps.reduce((a, b) => a + b, 0) / ps.length }));
}

// Probability of at least `need` successes among independent trials with odds ps
// (Poisson-binomial, computed exactly).
export function atLeast(ps, need) {
  let dist = [1];
  for (const p of ps) {
    const next = new Array(dist.length + 1).fill(0);
    dist.forEach((v, k) => { next[k] += v * (1 - p); next[k + 1] += v * p; });
    dist = next;
  }
  return dist.slice(need).reduce((a, b) => a + b, 0);
}

export function readiness(questions, records, scheduler, { passing = 26, now = new Date() } = {}) {
  const groups = groupOdds(questions, records, scheduler, now);
  const ps = groups.map(g => g.p);
  return {
    groups,
    expected: ps.reduce((a, b) => a + b, 0),
    passChance: atLeast(ps, passing),
  };
}

// A practice exam built like the real one: one random question from every group,
// in syllabus order (T1A, T1B, ... like a printed exam).
export function buildMock(questions, rand = Math.random) {
  const groups = new Map();
  for (const q of questions) {
    const g = groupOf(q.id);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(q);
  }
  return [...groups.values()].map(qs => qs[Math.floor(rand() * qs.length)]);
}

// "Book the exam" when the model says 95%+ and your latest practice exam passed too.
export function readyToBook(passChance, mocks, passing = 26) {
  const last = mocks[mocks.length - 1];
  return passChance >= 0.95 && !!last && last.score >= passing;
}

// ---------- lessons (Phase 3) ----------

// The study path: lesson groups in teaching order, flattened from the units in a lesson index.
export function studyPath(lessonIndex) {
  return lessonIndex ? lessonIndex.units.flatMap(u => u.groups) : [];
}

// The first lesson on the path you haven't read yet (only lessons that exist).
export function nextLesson(lessonIndex, read = {}) {
  return studyPath(lessonIndex).find(g => lessonIndex.lessons[g] && !read[g]) || null;
}

// Questions for practicing one lesson: every question in the group, shuffled.
export function groupQuestions(questions, group, rand = Math.random) {
  return shuffle(questions.filter(q => groupOf(q.id) === group), rand);
}
