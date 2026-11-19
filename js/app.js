import {
  DEFAULTS, makeScheduler, shuffleChoices, applyAnswer, statusOf, buildSession, requeue,
  progressBySubelement, refLinks, newIntroducedToday, readiness, buildMock, readyToBook,
} from './engine.js';
import * as store from './store.js';

const app = document.getElementById('app');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const LETTERS = 'ABCD';

const state = {
  manifest: null,
  pool: null,         // manifest entry
  questions: [],
  records: {},
  settings: { ...DEFAULTS },
  scheduler: null,
  session: null,
  view: 'home',
  notice: '',
};

// ---------- data ----------

async function loadPool(poolId) {
  const pool = state.manifest.pools.find(p => p.id === poolId) || state.manifest.pools[0];
  const res = await fetch(`pools/${pool.file}`);
  state.pool = pool;
  state.questions = await res.json();
  state.records = await store.loadRecords(pool.id);
  state.settings.pool = pool.id;
  await store.saveSettings(state.settings);
}

const subTitle = id => state.pool.subelements.find(s => s.id === id.slice(0, 2))?.title || '';

// ---------- views ----------

function render() {
  const views = { home: homeView, session: sessionView, summary: summaryView, settings: settingsView };
  app.innerHTML = views[state.view]();
  const focus = app.querySelector('[data-autofocus]');
  if (focus) focus.focus({ preventScroll: true });
}

function header() {
  const tabs = state.manifest.pools.map(p => `
    <button class="tab ${p.id === state.pool.id ? 'active' : ''}" data-action="pool" data-pool="${p.id}" aria-pressed="${p.id === state.pool.id}">${esc(p.name)}</button>`).join('');
  return `<header class="top">
    <h1>Ham Study Guide</h1>
    <nav class="tabs" aria-label="License class">${tabs}</nav>
  </header>`;
}

function homeView() {
  const now = new Date();
  const recs = state.records;
  const seen = Object.values(recs).filter(r => r.history?.length);
  const dueNow = state.questions.filter(q => recs[q.id]?.card && recs[q.id].card.due <= +now).length;
  const newLeft = Math.max(0, state.settings.newPerDay - newIntroducedToday(recs, now));
  const learned = state.questions.filter(q => statusOf(recs[q.id]) === 'learned').length;
  const unseen = state.questions.length - seen.length;
  const next = Math.min(state.settings.sessionSize, dueNow + Math.min(newLeft, unseen));
  const rows = progressBySubelement(state.questions, recs, state.pool.subelements).map(s => {
    const pct = n => (100 * n / s.total).toFixed(1);
    return `<li class="sub">
      <div class="sub-head"><span class="sub-id">${s.id}</span> ${esc(s.title)}
        <span class="sub-meta">${s.examQuestions} on exam · ${s.learned}/${s.total} learned</span></div>
      <div class="bar" role="img" aria-label="${s.learned} learned, ${s.learning} in progress, ${s.new} not seen">
        <span class="seg learned" style="width:${pct(s.learned)}%"></span><span class="seg learning" style="width:${pct(s.learning)}%"></span>
      </div>
    </li>`;
  }).join('');

  const startLabel = next ? `Start session · ${next} question${next === 1 ? '' : 's'}` : 'Nothing due right now';
  const hint = next ? '' : `<p class="hint">You've done today's new questions and nothing is due. Come back tomorrow, or raise the daily limit in Settings.</p>`;
  const fresh = seen.length === 0;
  const actions = fresh
    ? `<div class="diagnostic">
        <h2>Start with a cold diagnostic</h2>
        <p>Take a 35-question practice exam before studying anything. Guessing is fine; trying first makes the later studying stick better, and it gives you a starting score.</p>
        <button class="primary big" data-action="mock" data-kind="diagnostic" data-autofocus>Take the diagnostic · 35 questions</button>
        <p><button class="link" data-action="start">Skip it and start studying</button></p>
      </div>`
    : `<button class="primary big" data-action="start" ${next ? 'data-autofocus' : 'disabled'}>${startLabel}</button>
       ${hint}
       <button class="secondary big" data-action="mock" data-kind="practice">Take a practice exam · 35 questions</button>`;
  return `${header()}
  <main>
    ${state.notice ? `<p class="notice">${esc(state.notice)}</p>` : ''}
    ${readinessCard(now)}
    <section class="stats">
      <div class="stat"><b>${dueNow}</b><span>due for review</span></div>
      <div class="stat"><b>${Math.min(newLeft, unseen)}</b><span>new left today</span></div>
      <div class="stat"><b>${learned}<small>/${state.questions.length}</small></b><span>learned</span></div>
    </section>
    <div class="actions">${actions}</div>
    ${heatMap(now)}
    <section>
      <h2>Progress by subelement</h2>
      <p class="legend"><span class="key learned"></span>learned <span class="key learning"></span>in progress <span class="key new"></span>not seen</p>
      <ul class="subs">${rows}</ul>
    </section>
    <p class="foot">${esc(state.pool.name)} pool ${state.pool.validFrom.slice(0, 4)}–${state.pool.validTo.slice(0, 4)} · ${state.questions.length} questions · pass with ${state.pool.passing} of ${state.pool.examQuestions}
      · <button class="link" data-action="settings">Settings and backup</button></p>
  </main>`;
}

const mocksFor = () => (state.settings.mocks || []).filter(m => m.pool === state.pool.id);
const pct = x => `${Math.round(100 * x)}%`;

function readinessCard(now) {
  const r = readiness(state.questions, state.records, state.scheduler, { passing: state.pool.passing, now });
  const mocks = mocksFor();
  const last = mocks[mocks.length - 1];
  const exam = state.pool.examQuestions;
  const passAt = state.pool.passing;
  const ready = readyToBook(r.passChance, mocks, passAt);
  let verdict;
  if (ready) verdict = `<p class="ready">You're ready. Book your ${esc(state.pool.name)} exam.</p>`;
  else if (r.passChance >= 0.95) verdict = `<p class="hint">The model says you're ready. Pass a practice exam to confirm it.</p>`;
  else verdict = `<p class="hint">Book the exam when this passes 95% and your latest practice exam passes too.</p>`;
  const lastMock = last
    ? `<span>Last practice exam: <b>${last.score}/${exam}</b> ${last.score >= passAt ? '(pass)' : '(not yet)'} · ${new Date(last.t).toLocaleDateString()}</span>`
    : `<span>No practice exam yet</span>`;
  return `<section class="readiness" aria-label="Exam readiness">
    <div class="ready-row">
      <div><span class="label">Predicted score</span><b class="big-num">${r.expected.toFixed(1)}<small>/${exam}</small></b></div>
      <div><span class="label">Chance of passing</span><b class="big-num">${r.passChance < 0.005 ? '&lt;1%' : r.passChance > 0.995 ? '&gt;99%' : pct(r.passChance)}</b></div>
    </div>
    <div class="scale" role="img" aria-label="Predicted ${r.expected.toFixed(1)} of ${exam}; passing is ${passAt}">
      <span class="fill ${r.expected >= passAt ? 'ok' : ''}" style="width:${(100 * r.expected / exam).toFixed(1)}%"></span>
      <span class="passline" style="left:${(100 * passAt / exam).toFixed(1)}%"><em>pass ${passAt}</em></span>
    </div>
    ${verdict}
    <p class="hint">${lastMock}</p>
  </section>`;
}

function heatMap(now) {
  const r = readiness(state.questions, state.records, state.scheduler, { passing: state.pool.passing, now });
  const odds = new Map(r.groups.map(g => [g.group, g.p]));
  const rows = state.pool.subelements.map(s => {
    const cells = [...odds.keys()].filter(g => g.startsWith(s.id)).map(g => {
      const p = odds.get(g);
      const level = p < 0.4 ? 0 : p < 0.6 ? 1 : p < 0.8 ? 2 : 3;
      return `<span class="cell l${level}" title="${g}: ${pct(p)} chance right">${g.slice(2)}</span>`;
    }).join('');
    return `<div class="heat-row"><span class="heat-id">${s.id}</span><span class="heat-cells">${cells}</span><span class="heat-title">${esc(s.title)}</span></div>`;
  }).join('');
  return `<section>
    <h2>Your odds on each exam question</h2>
    <p class="legend">Each square is one question on the exam (one per group). <span class="key l0"></span>under 40% <span class="key l1"></span>40–60% <span class="key l2"></span>60–80% <span class="key l3"></span>80%+</p>
    <div class="heat">${rows}</div>
  </section>`;
}

function sessionView() {
  const s = state.session;
  const c = s.current;
  const q = c.q;
  const total = s.total;
  const done = s.answered;
  const fig = q.figure ? `<figure><img src="pools/figures/${esc(q.figure)}" alt="Figure ${esc(q.figure.replace('.png', '').toUpperCase())} from the question pool"></figure>` : '';
  const choices = c.choices.map((ch, i) => {
    let cls = 'choice';
    if (c.phase === 'feedback') {
      if (ch.index === q.correct) cls += ' right';
      else if (i === c.picked) cls += ' wrong';
    } else if (i === c.picked) cls += ' picked';
    const disabled = c.phase === 'feedback' ? 'disabled' : '';
    return `<li><button class="${cls}" data-action="pick" data-i="${i}" ${disabled}><span class="letter">${LETTERS[i]}</span><span>${esc(ch.text)}</span></button></li>`;
  }).join('');

  let footer = '';
  if (c.phase === 'confirm') {
    footer = `<div class="confirm">
      <p>How sure are you?</p>
      <div class="row">
        <button class="primary" data-action="sure" data-autofocus>I'm sure <kbd>S</kbd></button>
        <button class="secondary" data-action="guess">I'm guessing <kbd>G</kbd></button>
      </div></div>`;
  } else if (c.phase === 'feedback') {
    const right = c.choices.find(ch => ch.index === q.correct);
    const rightLetter = LETTERS[c.choices.indexOf(right)];
    let verdict;
    if (c.correct && c.sure) verdict = `<p class="verdict good">Correct.</p>`;
    else if (c.correct) verdict = `<p class="verdict meh">Correct, but you were guessing. It'll come back soon so it sticks.</p>`;
    else verdict = `<p class="verdict bad">Not this time. The answer is <b>${rightLetter}</b>: ${esc(right.text)}</p>`;
    const links = refLinks(q.refs);
    const refs = links.length ? `<p class="refs">FCC rule: ${links.map(l => `<a href="${l.url}" target="_blank" rel="noopener">${esc(l.label)}</a>`).join(', ')}</p>` : '';
    footer = `<div class="feedback">${verdict}${refs}
      <button class="primary" data-action="next" data-autofocus>${s.queue.length ? 'Next' : 'Finish'} <kbd>Enter</kbd></button></div>`;
  }

  return `<header class="top session-top">
    <button class="link" data-action="quit">✕ ${s.mode === 'mock' ? 'Stop exam' : 'End session'}</button>
    ${s.mode === 'mock' ? `<span class="mode">${s.kind === 'diagnostic' ? 'Diagnostic' : 'Practice exam'}</span>` : ''}
    <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}"><span style="width:${(100 * done / total).toFixed(1)}%"></span></div>
    <span class="count">${done}/${total}</span>
  </header>
  <main class="card">
    <p class="qid">${esc(q.id)} · ${esc(subTitle(q.id))}${c.repeat ? ' · <span class="again">again</span>' : ''}</p>
    <h2 class="question">${esc(q.question)}</h2>
    ${fig}
    <ol class="choices">${choices}</ol>
    ${footer}
  </main>`;
}

function summaryView() {
  const s = state.session;
  if (s.mode === 'mock') return mockSummaryView();
  const firsts = s.firstTry;
  const good = firsts.filter(r => r.correct && r.sure).length;
  const misses = firsts.filter(r => !(r.correct && r.sure));
  const list = misses.length ? `<h2>Worth another look</h2><ul class="misses">${misses.map(r => `<li><b>${esc(r.q.id)}</b> ${esc(r.q.question)}<br><span class="ans">${esc(r.q.answers[r.q.correct])}</span></li>`).join('')}</ul>` : '';
  return `${header()}
  <main>
    <h2>Session done</h2>
    <section class="stats">
      <div class="stat"><b>${firsts.length}</b><span>questions</span></div>
      <div class="stat"><b>${good}</b><span>right and sure first time</span></div>
      <div class="stat"><b>${s.repeats}</b><span>repeats to fix misses</span></div>
    </section>
    <button class="primary big" data-action="home" data-autofocus>Back to overview</button>
    ${list}
  </main>`;
}

function mockSummaryView() {
  const s = state.session;
  const exam = state.pool.examQuestions;
  const passAt = state.pool.passing;
  const score = s.results.filter(r => r.correct).length;
  const passed = score >= passAt;
  const bySub = state.pool.subelements.map(sub => {
    const rs = s.results.filter(r => r.q.id.startsWith(sub.id));
    const right = rs.filter(r => r.correct).length;
    return `<tr><td><b>${sub.id}</b> ${esc(sub.title)}</td><td class="num ${right === rs.length ? 'all' : ''}">${right}/${rs.length}</td></tr>`;
  }).join('');
  const misses = s.results.filter(r => !r.correct);
  const lucky = s.results.filter(r => r.correct && !r.sure).length;
  const list = misses.length ? `<h2>Missed (${misses.length})</h2><ul class="misses">${misses.map(r => `<li><b>${esc(r.q.id)}</b> ${esc(r.q.question)}<br><span class="ans">${esc(r.q.answers[r.q.correct])}</span></li>`).join('')}</ul>` : '';
  const title = s.kind === 'diagnostic' ? 'Diagnostic done' : 'Practice exam done';
  const note = s.kind === 'diagnostic'
    ? `<p>This is your starting point; most people start well under the pass mark. Every question you just answered is now in your study queue, misses first.</p>`
    : `<p>Before this exam the model predicted <b>${s.predicted.toFixed(1)}</b>. ${Math.abs(score - s.predicted) <= 3 ? 'That lines up, so the readiness score is tracking reality.' : score > s.predicted ? 'You beat the prediction. The model is being cautious, which is the safe direction.' : 'You scored below the prediction. Trust the exam over the model, and keep studying.'}</p>`;
  return `${header()}
  <main>
    <h2>${title}</h2>
    <section class="stats">
      <div class="stat"><b>${score}<small>/${exam}</small></b><span>${passed ? 'pass' : `pass is ${passAt}`}</span></div>
      <div class="stat"><b>${exam - score}</b><span>missed</span></div>
      <div class="stat"><b>${lucky}</b><span>right but guessed</span></div>
    </section>
    ${note}
    <button class="primary big" data-action="home" data-autofocus>Back to overview</button>
    <h2>By subelement</h2>
    <table class="breakdown">${bySub}</table>
    ${list}
  </main>`;
}

function settingsView() {
  const opt = (name, values, current) => values.map(v => `<option value="${v}" ${v === current ? 'selected' : ''}>${v}</option>`).join('');
  return `${header()}
  <main>
    <h2>Settings</h2>
    <label class="field">New questions per day
      <select data-setting="newPerDay">${opt('newPerDay', [10, 15, 20, 30, 40], state.settings.newPerDay)}</select>
      <small>About 20 fits a 30-minute day. Applies to each license class separately.</small></label>
    <label class="field">Questions per session
      <select data-setting="sessionSize">${opt('sessionSize', [15, 20, 30, 40, 50], state.settings.sessionSize)}</select></label>

    <h2>Backup</h2>
    <p>Progress is saved in this browser only. Export a backup to move it to another device, then import it there.</p>
    <div class="row">
      <button class="secondary" data-action="export">Export backup</button>
      <label class="secondary filebtn">Import backup<input type="file" accept="application/json,.json" data-action="import" hidden></label>
    </div>

    <h2>Start over</h2>
    <p>Erase all ${esc(state.pool.name)} progress on this device.</p>
    ${state.confirmReset
      ? `<div class="row"><button class="danger" data-action="reset-yes">Yes, erase ${esc(state.pool.name)} progress</button><button class="secondary" data-action="reset-no">Cancel</button></div>`
      : `<button class="secondary" data-action="reset">Reset ${esc(state.pool.name)} progress</button>`}

    <p><button class="primary" data-action="home">Done</button></p>
    <p class="foot">Questions: NCVEC public-domain pools (${esc(state.pool.source)}). Scheduling: FSRS via ts-fsrs.</p>
  </main>`;
}

// ---------- session flow ----------

function startSession() {
  const { questions, dueCount, newCount } = buildSession(state.questions, state.records, {
    scheduler: state.scheduler,
    newPerDay: state.settings.newPerDay,
    sessionSize: state.settings.sessionSize,
  });
  if (!questions.length) return;
  state.session = { queue: questions, total: questions.length, answered: 0, repeats: 0, firstTry: [], seen: new Map(), dueCount, newCount };
  nextQuestion();
  state.view = 'session';
  render();
}

function startMock(kind) {
  const questions = buildMock(state.questions);
  const r = readiness(state.questions, state.records, state.scheduler, { passing: state.pool.passing });
  state.session = { mode: 'mock', kind, queue: questions, total: questions.length, answered: 0, repeats: 0, firstTry: [], results: [], seen: new Map(), predicted: r.expected };
  nextQuestion();
  state.view = 'session';
  render();
}

async function finishMock() {
  const s = state.session;
  const score = s.results.filter(r => r.correct).length;
  state.settings.mocks = [...(state.settings.mocks || []), { pool: state.pool.id, kind: s.kind, t: Date.now(), score, predicted: +s.predicted.toFixed(2) }];
  await store.saveSettings(state.settings);
  state.view = 'summary';
  render();
}

function nextQuestion() {
  const s = state.session;
  const q = s.queue.shift();
  const repeat = s.seen.has(q.id);
  s.current = { q, choices: shuffleChoices(q), picked: null, phase: 'ask', repeat };
}

function pick(i) {
  const c = state.session.current;
  if (c.phase === 'feedback') return;
  c.picked = i;
  c.phase = 'confirm';
  render();
}

async function confirm(sure) {
  const s = state.session;
  const c = s.current;
  if (c.phase !== 'confirm') return;
  c.sure = sure;
  c.correct = c.choices[c.picked].index === c.q.correct;
  c.phase = 'feedback';
  s.answered++;

  const updated = applyAnswer(state.scheduler, state.records[c.q.id] || { id: c.q.id }, { correct: c.correct, sure, mock: s.mode === 'mock' });
  state.records[c.q.id] = updated;
  store.saveRecord(state.pool.id, updated).catch(err => console.error('save failed', err));

  if (s.mode === 'mock') {
    // Exam conditions: no feedback until the end, no repeats.
    s.results.push({ q: c.q, correct: c.correct, sure });
    advance();
    return;
  }
  if (!c.repeat) s.firstTry.push({ q: c.q, correct: c.correct, sure });
  const times = s.seen.get(c.q.id) || 0;
  s.seen.set(c.q.id, times + 1);
  if (!(c.correct && sure) && times < DEFAULTS.maxRepeats) {
    s.queue = requeue(s.queue, c.q);
    s.total++;
    s.repeats++;
  }
  render();
}

function advance() {
  const s = state.session;
  if (s.queue.length) { nextQuestion(); render(); }
  else if (s.mode === 'mock') finishMock();
  else { state.view = 'summary'; render(); }
}

// ---------- events ----------

app.addEventListener('click', async e => {
  const el = e.target.closest('[data-action]');
  if (!el || el.tagName === 'INPUT') return;
  const a = el.dataset.action;
  state.notice = '';
  if (a === 'pool') { await loadPool(el.dataset.pool); state.view = 'home'; render(); }
  else if (a === 'start') startSession();
  else if (a === 'mock') startMock(el.dataset.kind || 'practice');
  else if (a === 'pick') pick(Number(el.dataset.i));
  else if (a === 'sure') confirm(true);
  else if (a === 'guess') confirm(false);
  else if (a === 'next') advance();
  else if (a === 'quit') {
    // A stopped practice exam isn't scored; answers so far still count toward studying.
    state.view = state.session.mode !== 'mock' && state.session.answered ? 'summary' : 'home';
    render();
  }
  else if (a === 'home') { state.view = 'home'; state.confirmReset = false; render(); }
  else if (a === 'settings') { state.view = 'settings'; render(); }
  else if (a === 'export') exportBackup();
  else if (a === 'reset') { state.confirmReset = true; render(); }
  else if (a === 'reset-no') { state.confirmReset = false; render(); }
  else if (a === 'reset-yes') {
    await store.resetPool(state.pool.id);
    state.records = {};
    state.settings.mocks = (state.settings.mocks || []).filter(m => m.pool !== state.pool.id);
    await store.saveSettings(state.settings);
    state.confirmReset = false;
    state.notice = `${state.pool.name} progress erased.`;
    state.view = 'home';
    render();
  }
});

app.addEventListener('change', async e => {
  const el = e.target;
  if (el.dataset.setting) {
    state.settings[el.dataset.setting] = Number(el.value);
    await store.saveSettings(state.settings);
  } else if (el.dataset.action === 'import' && el.files?.[0]) {
    try {
      const data = JSON.parse(await el.files[0].text());
      const n = await store.importAll(data);
      state.settings = { ...DEFAULTS, ...(await store.loadSettings()) };
      await loadPool(state.settings.pool || state.pool.id);
      state.notice = `Backup restored: ${n} question records.`;
    } catch (err) {
      state.notice = `Couldn't import that file: ${err.message}`;
    }
    state.view = 'home';
    render();
  }
});

document.addEventListener('keydown', e => {
  if (state.view !== 'session' || e.metaKey || e.ctrlKey || e.altKey) return;
  const c = state.session.current;
  const k = e.key.toLowerCase();
  if (['1', '2', '3', '4', 'a', 'b', 'c', 'd'].includes(k) && c.phase !== 'feedback') {
    const i = '1234'.includes(k) ? Number(k) - 1 : 'abcd'.indexOf(k);
    if (i < c.choices.length) { e.preventDefault(); pick(i); }
  } else if (k === 's' && c.phase === 'confirm') { e.preventDefault(); confirm(true); }
  else if (k === 'g' && c.phase === 'confirm') { e.preventDefault(); confirm(false); }
  else if (k === 'enter' && c.phase === 'feedback') { e.preventDefault(); advance(); }
});

async function exportBackup() {
  const data = await store.exportAll();
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ham-study-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- boot ----------

async function boot() {
  try {
    state.manifest = await (await fetch('pools/pools.json')).json();
    state.settings = { ...DEFAULTS, ...(await store.loadSettings()) };
    state.scheduler = makeScheduler(state.settings.retention);
    await loadPool(state.settings.pool || state.manifest.pools[0].id);
    render();
  } catch (err) {
    console.error(err);
    app.innerHTML = `<main><h1>Ham Study Guide</h1><p class="notice">Couldn't load the question pools. If you opened index.html straight from disk, run <code>npm run serve</code> and open <code>http://localhost:8000</code> instead.</p></main>`;
  }
}

boot();
