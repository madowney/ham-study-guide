// Browser smoke test. Start a server first (npm run serve), then:
//   BASE=http://localhost:8000 SHOTS=/tmp/shots node tests/smoke.e2e.mjs
import { createRequire } from 'node:module';
const { chromium, devices } = createRequire(import.meta.url)('playwright');
import assert from 'node:assert/strict';

const BASE = process.env.BASE || 'http://localhost:8000';
const SHOTS = process.env.SHOTS;
const browser = await chromium.launch();
const errors = [];

async function run(name, contextOpts) {
  const ctx = await browser.newContext(contextOpts);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  await page.goto(BASE);
  await page.getByRole('button', { name: /Start session · 20 questions/ }).waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}-home.png`, fullPage: true });

  await page.getByRole('button', { name: /Start session/ }).click();
  // Answer 20 questions: miss the first one on purpose, guess the second, then answer correctly and sure.
  let answered = 0, missesForced = 0;
  for (let guard = 0; guard < 60; guard++) {
    if (await page.getByRole('heading', { name: 'Session done' }).isVisible()) break;
    const qid = (await page.locator('.qid').innerText()).split(' ')[0];
    const correct = await page.evaluate(async id => {
      const pools = await (await fetch('pools/pools.json')).json();
      const pool = pools.pools.find(p => id.startsWith(p.subelements[0].id[0]));
      const qs = await (await fetch(`pools/${pool.file}`)).json();
      const q = qs.find(x => x.id === id);
      return q.answers[q.correct];
    }, qid);
    const buttons = page.locator('.choice');
    const bodies = await buttons.locator('span:nth-child(2)').allInnerTexts();
    let idx = bodies.findIndex(t => t.trim() === correct.trim());
    assert.ok(idx >= 0, `correct answer for ${qid} not shown`);
    if (answered === 0) { idx = (idx + 1) % 4; missesForced++; }
    await buttons.nth(idx).click();
    if (answered === 1) await page.getByRole('button', { name: /guessing/ }).click();
    else await page.getByRole('button', { name: /I'm sure/ }).click();
    if (answered === 0 && SHOTS) await page.screenshot({ path: `${SHOTS}/${name}-feedback-miss.png`, fullPage: true });
    if (answered === 1) assert.match(await page.locator('.verdict').innerText(), /guessing/);
    answered++;
    await page.getByRole('button', { name: /Next|Finish/ }).click();
  }
  assert.ok(await page.getByRole('heading', { name: 'Session done' }).isVisible(), 'session should finish');
  assert.equal(answered, 22, '20 questions plus 2 repeats for the miss and the guess');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}-summary.png`, fullPage: true });

  // Progress persists across reload.
  await page.reload();
  await page.locator('.stat b').first().waitFor();
  const stats = await page.locator('.stat b').allInnerTexts();
  assert.equal(stats[1], '0', 'no new questions left today');
  assert.match(await page.locator('.subs').innerText(), /T1/);

  // Switch to General: fresh pool, 20 new.
  await page.getByRole('button', { name: 'General' }).click();
  await page.getByRole('button', { name: /Start session · 20 questions/ }).waitFor();

  // Keyboard flow on desktop.
  if (!contextOpts?.isMobile) {
    await page.getByRole('button', { name: /Start session/ }).click();
    await page.keyboard.press('1');
    await page.keyboard.press('s');
    await page.locator('.verdict').waitFor();
    await page.keyboard.press('Enter');
    assert.match(await page.locator('.count').innerText(), /^1\//);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}-general-question.png`, fullPage: true });
  }
  // Settings + export.
  await page.goto(BASE);
  await page.getByRole('button', { name: /Settings and backup/ }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export backup' }).click()]);
  assert.match(download.suggestedFilename(), /^ham-study-backup-.*\.json$/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}-settings.png`, fullPage: true });
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
