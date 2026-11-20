// Browser smoke test. Start a server first (npm run serve), then:
//   BASE=http://localhost:8000 SHOTS=/tmp/shots NODE_PATH=$(npm root -g) node tests/smoke.e2e.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const { chromium, devices } = createRequire(import.meta.url)('playwright');

const BASE = process.env.BASE || 'http://localhost:8000';
const SHOTS = process.env.SHOTS;
const browser = await chromium.launch();
const errors = [];

async function correctIndex(page) {
  await page.locator('.choice').first().waitFor();
  const qid = (await page.locator('.qid').innerText()).split(' ')[0];
  const correct = await page.evaluate(async id => {
    window.__pools ||= {};
    const pools = await (await fetch('pools/pools.json')).json();
    const pool = pools.pools.find(p => id.startsWith(p.subelements[0].id[0]));
    window.__pools[pool.id] ||= await (await fetch(`pools/${pool.file}`)).json();
    const q = window.__pools[pool.id].find(x => x.id === id);
    return q.answers[q.correct];
  }, qid);
  const bodies = await page.locator('.choice span:nth-child(2)').allInnerTexts();
  const idx = bodies.findIndex(t => t.trim() === correct.trim());
  assert.ok(idx >= 0, `correct answer for ${qid} not shown`);
  return idx;
}

async function answer(page, { right = true, sure = true } = {}) {
  const idx = await correctIndex(page);
  await page.locator('.choice').nth(right ? idx : (idx + 1) % 4).click();
  await page.getByRole('button', { name: sure ? /I'm sure/ : /guessing/ }).click();
}

const shot = (page, file) => SHOTS && page.screenshot({ path: `${SHOTS}/${file}.png`, fullPage: true });

async function run(name, contextOpts) {
  const ctx = await browser.newContext(contextOpts);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });

  // 1. A fresh pool offers the diagnostic and predicts a near-certain fail.
  await page.goto(BASE);
  await page.getByRole('button', { name: /Take the diagnostic/ }).waitFor();
  assert.match(await page.locator('.readiness').innerText(), /8\.8\s*\/35[\s\S]*<1%/);
  assert.equal(await page.locator('.heat .cell').count(), 35);
  await shot(page, `${name}-1-fresh`);

  // 2. Diagnostic: 28 right, 7 wrong; no feedback until the end.
  await page.getByRole('button', { name: /Take the diagnostic/ }).click();
  for (let i = 0; i < 35; i++) {
    assert.match(await page.locator('.count').innerText(), new RegExp(`^${i}/35`));
    await answer(page, { right: i < 28 });
    if (i < 34) assert.equal(await page.locator('.verdict').count(), 0, 'no feedback during the exam');
  }
  await page.getByRole('heading', { name: 'Diagnostic done' }).waitFor();
  assert.match(await page.locator('.stats').innerText(), /28\s*\/35/);
  assert.equal(await page.locator('.misses li').count(), 7);
  await shot(page, `${name}-2-diagnostic-result`);

  // 3. Home now shows the diagnostic score, a higher prediction, and the first lesson.
  await page.getByRole('button', { name: 'Back to overview' }).click();
  const card = await page.locator('.readiness').innerText();
  assert.match(card, /Last practice exam: 28\/35/);
  const predicted = Number(card.match(/([\d.]+)\s*\/35/)[1]);
  assert.ok(predicted > 9, `prediction should rise after a good diagnostic (got ${predicted})`);
  assert.match(await page.locator('.lesson-next').innerText(), /Next lesson · 1 of 35[\s\S]*Radio waves/);
  await page.getByRole('button', { name: /Daily review|No reviews due/ }).waitFor();
  await shot(page, `${name}-3-home-after-diagnostic`);

  // 4. Read the first lesson, then practice its questions: miss one, guess one, the rest right and sure.
  await page.getByRole('button', { name: 'Read the lesson' }).click();
  await page.locator('#lesson-body .keyfacts').waitFor();
  assert.match(await page.locator('.lesson h1').innerText(), /Radio waves/);
  assert.ok(await page.locator('#lesson-body svg').count() > 0, 'lesson has a diagram');
  await shot(page, `${name}-4-lesson`);
  const practiceBtn = page.getByRole('button', { name: /Practice now · \d+ questions/ });
  const n = Number((await practiceBtn.innerText()).match(/(\d+) questions/)[1]);
  assert.equal(n, 12);
  await practiceBtn.click();
  let answered = 0;
  for (let guard = 0; guard < 80; guard++) {
    if (await page.getByRole('heading', { name: /Practice done/ }).isVisible()) break;
    await answer(page, { right: answered !== 0, sure: answered !== 1 });
    if (answered === 0) {
      await shot(page, `${name}-5-feedback-miss`);
      // The feedback links back to the lesson, and you can return to the same question.
      const qid = await page.locator('.qid').innerText();
      await page.locator('[data-action="lesson-from-session"]').click();
      await page.locator('#lesson-body .keyfacts').waitFor();
      await page.getByRole('button', { name: 'Back to the question', exact: true }).click();
      assert.equal(await page.locator('.qid').innerText(), qid);
      await page.locator('.verdict').waitFor();
    }
    answered++;
    await page.getByRole('button', { name: /Next|Finish/ }).click();
  }
  assert.ok(await page.getByRole('heading', { name: /Practice done/ }).isVisible());
  assert.equal(answered, n + 2);
  await page.getByRole('button', { name: /Next lesson: What amateur radio is for/ }).waitFor();
  await page.getByRole('button', { name: 'Back to overview' }).click();

  // 5. Progress survives a reload, and the lesson list shows what has been read.
  await page.reload();
  await page.locator('.stat b').first().waitFor();
  assert.match((await page.locator('.stats .stat b').allInnerTexts())[1], /^1\s*\/35$/, 'one lesson read');
  assert.match(await page.locator('.lesson-next').innerText(), /2 of 35/);
  await page.getByRole('button', { name: 'All lessons' }).click();
  assert.equal(await page.locator('.lesson-list li').count(), 35);
  assert.equal(await page.locator('.lesson-list .tick', { hasText: '✓' }).count(), 1);
  await shot(page, `${name}-6-lesson-list`);
  await page.getByRole('button', { name: /Overview/ }).click();

  // 6. Stopping a practice exam early doesn't record a score.
  await page.getByRole('button', { name: /Take a practice exam/ }).click();
  for (let i = 0; i < 3; i++) await answer(page);
  await page.getByRole('button', { name: /Stop exam/ }).click();
  assert.match(await page.locator('.readiness').innerText(), /Last practice exam: 28\/35/);

  // 7. A full practice exam, all right: score recorded and compared with the prediction.
  await page.getByRole('button', { name: /Take a practice exam/ }).click();
  for (let i = 0; i < 35; i++) await answer(page);
  await page.getByRole('heading', { name: 'Practice exam done' }).waitFor();
  assert.match(await page.locator('main').innerText(), /model predicted/);
  await shot(page, `${name}-7-practice-result`);
  await page.getByRole('button', { name: 'Back to overview' }).click();
  assert.match(await page.locator('.readiness').innerText(), /Last practice exam: 35\/35 \(pass\)/);
  await shot(page, `${name}-8-home-after-practice`);

  // 8. General is a separate, fresh pool with its own lessons. Skip the diagnostic straight to
  // the first lesson (it shows the exam's band-plan table), then the keyboard flow on desktop.
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await page.getByRole('button', { name: /Take the diagnostic/ }).waitFor();
  await page.getByRole('button', { name: /Skip it and go to the first lesson/ }).click();
  await page.locator('#lesson-body .keyfacts').waitFor();
  assert.match(await page.locator('.lesson h1').innerText(), /General band privileges/);
  await shot(page, `${name}-9-general-lesson`);
  await page.getByRole('button', { name: /Practice now · 10 questions/ }).click();
  await page.locator('.choice').first().waitFor();
  if (!contextOpts?.isMobile) {
    await page.keyboard.press('1');
    await page.keyboard.press('s');
    await page.locator('.verdict').waitFor();
    await page.keyboard.press('Enter');
    assert.match(await page.locator('.count').innerText(), /^1\//);
  }

  // 9. Backup export.
  await page.goto(BASE);
  await page.getByRole('button', { name: /Settings and backup/ }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export backup' }).click()]);
  assert.match(download.suggestedFilename(), /^ham-study-backup-.*\.json$/);
  await ctx.close();
  console.log(`ok ${name}`);
}

try {
  await run('desktop', { viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  await run('phone', { ...devices['iPhone 13'], acceptDownloads: true });
  assert.deepEqual(errors, [], 'no console errors');
  console.log('smoke test passed');
} finally {
  await browser.close();
}
