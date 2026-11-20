# Ham Study Guide

A study tool for the FCC **Technician** (Element 2) and **General** (Element 3) amateur radio exams. It runs in the browser on a laptop or phone, with no account and no server, and keeps your progress on your device.

It teaches the material and then drills it, following the research on how people learn fastest for a multiple-choice exam with a public question pool:

- **Lessons first, then questions.** Each of the 35 question groups has a short lesson (3 to 5 minutes) that explains the ideas behind its questions, with diagrams and a key-facts box. The guide walks you through them in teaching order, starting with what a radio wave is, not in syllabus order. Right after each lesson you answer that group's questions, and new questions only come from lessons you've read. Every wrong answer links back to its lesson.
- **Retrieval practice.** You learn by answering questions, not by rereading.
- **Spaced repetition.** The [FSRS](https://github.com/open-spaced-repetition/ts-fsrs) scheduler brings each question back just before you're likely to forget it.
- **Interleaving.** Each session mixes subelements and introduces new questions across all 35 groups before repeating any group.
- **Confidence check.** After picking an answer you tap *I'm sure* or *I'm guessing*. A correct guess is scheduled like a miss, so lucky guesses don't count as learned.
- **Successive relearning.** A missed question comes back later in the same session. A question only counts as *learned* after sure, correct answers on two different days.
- **Shuffled choices.** Answer order changes every time, so you learn the answer instead of its letter. "All these choices are correct" stays last.
- **Readiness score.** The guide predicts your exam score and your chance of passing. A question counts toward the prediction only if your last answer to it was sure and correct, discounted by how likely FSRS thinks you still remember it, with a 25% floor for a blind guess. The exam draws one question from each of 35 groups, so each group's odds average its questions, and the pass chance is computed exactly from those 35 odds. A heat map shows the 35 groups so you can see where the points are.
- **Practice exams.** Each one is built like the real exam: one random question per group, with no feedback until the end. Your first one is an optional cold diagnostic. Answers update your study schedule, but questions first seen in an exam don't use up the daily new-question limit.
- **When to book.** The guide says *you're ready* once your predicted pass chance reaches 95% and your latest practice exam also passed.

## Use it

Once GitHub Pages is on, open **https://madowney.github.io/ham-study-guide/** on your laptop or phone. On a phone, use *Add to Home Screen* to get an app icon.

Keyboard shortcuts: `1`–`4` or `A`–`D` pick an answer, `S` means sure, `G` means guessing, and `Enter` moves to the next question.

Progress lives in each browser separately. To move it between devices, use **Settings → Export backup** on one device and **Import backup** on the other.

### Turning on GitHub Pages (one time)

Go to repo **Settings → Pages**. Under *Build and deployment*, choose **Deploy from a branch**, then branch **main** and folder **/ (root)**, and save. The site goes live a minute or two later.

## Run it locally

```sh
npm run serve        # python3 -m http.server 8000
# open http://localhost:8000
```

Opening `index.html` straight from disk doesn't work, because browsers block module scripts and data loading from `file://` pages.

## Question pools

| Pool | Valid | Questions | Exam |
| --- | --- | --- | --- |
| Technician 2026–2030 | Jul 1, 2026 – Jun 30, 2030 | 409 | 35 questions, pass with 26 |
| General 2023–2027 | Jul 1, 2023 – Jun 30, 2027 | 423 | 35 questions, pass with 26 |

NCVEC releases the questions into the public domain. The JSON files come from [russolsen/ham_radio_question_pool](https://github.com/russolsen/ham_radio_question_pool) (Apache 2.0, see `pools/LICENSE-question-pool-json.txt`). `npm run validate` checks every pool against the NCVEC syllabus: question counts per subelement, one group per exam question, four answers each, figures present, and withdrawn questions absent. It also checks that a pool's lesson index covers every group once and that each lesson file and image exists.

**Adding a new pool** (for example the 2027–2031 General pool) means adding its JSON and figures to `pools/` and an entry to `pools/pools.json`.

## Development

```sh
npm test             # unit tests for the study engine (node --test)
npm run validate     # pool integrity checks
# browser smoke test (needs Playwright and a running server):
BASE=http://localhost:8000 node tests/smoke.e2e.mjs
```

| Path | What it is |
| --- | --- |
| `index.html`, `css/style.css` | App shell and styles (light and dark) |
| `js/engine.js` | Pure study logic: session building, scheduling, status, shuffling |
| `js/store.js` | IndexedDB storage, backup export and import |
| `js/app.js` | Views and interaction |
| `vendor/ts-fsrs.mjs` | FSRS scheduler, ts-fsrs 5.4.2 (MIT) |
| `pools/` | Question pools, figures, and the pool manifest |
| `lessons/<pool>/` | One HTML lesson per question group, and `index.json` with the teaching order |

No build step and no dependencies at runtime.

## Roadmap

1. **Drill tool:** spaced repetition, confidence check, feedback, saved progress. *(done)*
2. **Readiness:** cold diagnostic, practice exams built like the real one, predicted score, pass probability, and group heat map. *(done)*
3. **Lessons:** a short lesson for every question group, in teaching order, with practice right after reading. *(done for both pools)*
4. **Polish:** offline install, settings for target retention, pool switcher for 2027.
