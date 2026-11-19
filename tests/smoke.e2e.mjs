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

  // 3. Home now shows the diagnostic score, a higher prediction, and a full day of new questions.
  await page.getByRole('button', { name: 'Back to overview' }).click();
  const card = await page.locator('.readiness').innerText();
  assert.match(card, /Last practice exam: 28\/35/);
  const predicted = Number(card.match(/([\d.]+)\s*\/35/)[1]);
  assert.ok(predicted > 9, `prediction should rise after a good diagnostic (got ${predicted})`);
  const startBtn = page.getByRole('button', { name: /Start session · \d+ questions/ });
  const n = Number((await startBtn.innerText()).match(/(\d+) questions/)[1]);
  assert.ok(n >= 20, 'diagnostic does not use up the daily new budget');
  await shot(page, `${name}-3-home-after-diagnostic`);

  // 4. Study session: miss one, guess one, the rest right and sure. Two repeats expected.
  await startBtn.click();
  let answered = 0;
  for (let guard = 0; guard < 80; guard++) {
    if (await page.getByRole('heading', { name: 'Session done' }).isVisible()) break;
    await answer(page, { right: answered !== 0, sure: answered !== 1 });
    if (answered === 0) await shot(page, `${name}-4-feedback-miss`);
    answered++;
    await page.getByRole('button', { name: /Next|Finish/ }).click();
  }
  assert.ok(await page.getByRole('heading', { name: 'Session done' }).isVisible());
  assert.equal(answered, n + 2);

  // 5. Progress survives a reload.
  await page.reload();
  await page.locator('.stat b').first().waitFor();
  assert.equal((await page.locator('.stats .stat b').allInnerTexts())[1], '0', 'no new questions left today');

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
  await shot(page, `${name}-5-practice-result`);
  await page.getByRole('button', { name: 'Back to overview' }).click();
  assert.match(await page.locator('.readiness').innerText(), /Last practice exam: 35\/35 \(pass\)/);
  await shot(page, `${name}-6-home-after-practice`);

  // 8. General is a separate, fresh pool. Skip the diagnostic; keyboard flow on desktop.
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await page.getByRole('button', { name: /Take the diagnostic/ }).waitFor();
  await page.getByRole('button', { name: /Skip it and start studying/ }).click();
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
