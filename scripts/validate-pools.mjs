#!/usr/bin/env node
// Checks every question pool listed in pools/pools.json against the NCVEC syllabus
// counts recorded there. Run: node scripts/validate-pools.mjs
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'pools/pools.json'), 'utf8'));
let failures = 0;
const fail = (pool, msg) => { failures++; console.error(`  FAIL [${pool}] ${msg}`); };

for (const pool of manifest.pools) {
  const questions = JSON.parse(readFileSync(join(root, 'pools', pool.file), 'utf8'));
  console.log(`${pool.name} (${pool.id}): ${questions.length} questions`);

  const ids = new Set();
  const groups = new Set();
  const perSub = {};
  const prefix = pool.subelements[0].id[0];
  for (const q of questions) {
    if (!new RegExp(`^${prefix}[0-9][A-F][0-9]{2}$`).test(q.id)) fail(pool.id, `bad id ${q.id}`);
    if (ids.has(q.id)) fail(pool.id, `duplicate id ${q.id}`);
    ids.add(q.id);
    groups.add(q.id.slice(0, 3));
    perSub[q.id.slice(0, 2)] = (perSub[q.id.slice(0, 2)] || 0) + 1;
    if (!q.question || typeof q.question !== 'string') fail(pool.id, `${q.id} has no question text`);
    if (!Array.isArray(q.answers) || q.answers.length !== 4) fail(pool.id, `${q.id} does not have 4 answers`);
    if (new Set(q.answers).size !== q.answers.length) fail(pool.id, `${q.id} has duplicate answers`);
    if (!(Number.isInteger(q.correct) && q.correct >= 0 && q.correct < 4)) fail(pool.id, `${q.id} has bad correct index`);
    if (q.correct_letter && 'ABCD'[q.correct] !== q.correct_letter) fail(pool.id, `${q.id} correct and correct_letter disagree`);
    if (q.figure && !existsSync(join(root, 'pools/figures', q.figure))) fail(pool.id, `${q.id} figure ${q.figure} missing`);
  }

  const expectedTotal = pool.subelements.reduce((n, s) => n + s.poolQuestions, 0);
  const expectedExam = pool.subelements.reduce((n, s) => n + s.examQuestions, 0);
  if (questions.length !== expectedTotal) fail(pool.id, `expected ${expectedTotal} questions, found ${questions.length}`);
  if (expectedExam !== pool.examQuestions) fail(pool.id, `subelement exam counts sum to ${expectedExam}, not ${pool.examQuestions}`);
  if (groups.size !== pool.examQuestions) fail(pool.id, `expected ${pool.examQuestions} groups, found ${groups.size}`);
  for (const s of pool.subelements) {
    const subGroups = [...groups].filter(g => g.startsWith(s.id)).length;
    if ((perSub[s.id] || 0) !== s.poolQuestions) fail(pool.id, `${s.id}: expected ${s.poolQuestions} questions, found ${perSub[s.id] || 0}`);
    if (subGroups !== s.examQuestions) fail(pool.id, `${s.id}: expected ${s.examQuestions} groups, found ${subGroups}`);
  }
  for (const w of pool.withdrawn) if (ids.has(w)) fail(pool.id, `withdrawn question ${w} is still present`);

  // Lessons are optional per pool, but if an index exists it must be complete and consistent.
  const lessonDir = join(root, 'lessons', pool.id);
  const indexFile = join(lessonDir, 'index.json');
  if (existsSync(indexFile) && pool.lessons !== `lessons/${pool.id}/index.json`) fail(pool.id, `pools.json should set "lessons": "lessons/${pool.id}/index.json"`);
  if (pool.lessons && !existsSync(join(root, pool.lessons))) fail(pool.id, `lesson index ${pool.lessons} missing`);
  if (existsSync(indexFile)) {
    const index = JSON.parse(readFileSync(indexFile, 'utf8'));
    const listed = index.units.flatMap(u => u.groups);
    const written = Object.keys(index.lessons);
    for (const g of listed) if (!groups.has(g)) fail(pool.id, `lesson index lists unknown group ${g}`);
    if (new Set(listed).size !== listed.length) fail(pool.id, 'lesson index lists a group twice');
    for (const g of written) {
      if (!listed.includes(g)) fail(pool.id, `lesson ${g} is not in any unit`);
      if (!existsSync(join(lessonDir, `${g}.html`))) fail(pool.id, `lesson file ${g}.html missing`);
      const { title, minutes } = index.lessons[g];
      if (!title || !(minutes > 0)) fail(pool.id, `lesson ${g} needs a title and minutes`);
      const html = existsSync(join(lessonDir, `${g}.html`)) ? readFileSync(join(lessonDir, `${g}.html`), 'utf8') : '';
      for (const [, src] of html.matchAll(/src="([^"]+)"/g)) if (!existsSync(join(root, src))) fail(pool.id, `lesson ${g} image ${src} missing`);
    }
    console.log(`  lessons: ${written.length} of ${groups.size} groups written`);
  }
}

if (failures) { console.error(`\n${failures} problem(s) found.`); process.exit(1); }
console.log('\nAll pools match the syllabus counts.');
