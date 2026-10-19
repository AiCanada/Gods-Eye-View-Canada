/**
 * AI DISTILLATION's runs (owner request 2026-10-19). Under each of the seven
 * headings the owner adds sub-headings without limit; each is a saved run
 * with its own name, questions (typed or from a CSV file), teachers, prompts
 * and dataset, in .gev-data/distill/<id>/:
 *
 *   questions.json   the questions, in order
 *   dataset.jsonl    one record per ground truth: the question, the ground
 *                    truth answer, every turn (teacher, route, response id,
 *                    text) and every grade
 *   run.json         how far the run got (a run continues from there)
 *
 * One run goes at a time, one question at a time (heading 2 asks its teachers
 * three at a time). A teacher whose only route left needs the owner (the Chief
 * of Staff webhook, the Grok Bot or ChatGPT app) holds the run as WAITING
 * until its reply is pasted back or skipped. PAUSE finishes the question it
 * is on; STOP drops it; CONTINUE picks up at the next question.
 *
 * The answers are outputs of the providers' models: the datasets carry the
 * licence class `restricted` (their terms may limit training on them).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  DISTILL_DEFAULT_PROMPTS,
  DISTILL_HEADINGS,
  DISTILL_NAME_MAX,
  DISTILL_PICKS,
  DISTILL_PROMPT_MAX,
  DISTILL_QUESTIONS_MAX,
  DISTILL_QUESTION_MAX,
  DISTILL_TURN3_FROM,
  answersBlock,
  bestGraded,
  csvField,
  estimateRun,
  fillPrompt,
  groundTruthOf,
  planTurns,
  questionsFromCsv,
  questionsFromText,
  readGrades,
  reviewsBlock,
} from '../../src/distillCore.mjs';
import {
  askTeacher,
  localResponseId,
  teacherRoster,
} from './distillTeachers.mjs';

export const DISTILL_CLASS = 'restricted';
const PARALLEL = 3;
const ERRORS_KEPT = 20;
const CSV_BYTES = 4 * 1024 * 1024;

const refuse = (message, status = 400) =>
  Object.assign(new Error(message), { status });

/** A sub-heading's settings, cleaned against the teachers there are. */
export function cleanConfig(raw = {}, current = {}, teacherIds = []) {
  const known = new Set(teacherIds);
  const one = (value, fallback = '') => {
    if (value === undefined) return fallback;
    const id = String(value || '');
    if (id && !known.has(id)) throw refuse(`Unknown teacher: ${id}.`);
    return id;
  };
  const many = (value, fallback = []) => {
    if (value === undefined) return fallback;
    if (!Array.isArray(value)) throw refuse('Choose teachers from the list.');
    const ids = [...new Set(value.map(String))];
    for (const id of ids)
      if (!known.has(id)) throw refuse(`Unknown teacher: ${id}.`);
    return ids;
  };
  const prompts = { ...(current.prompts || {}) };
  if (raw.prompts !== undefined) {
    for (const key of Object.keys(DISTILL_DEFAULT_PROMPTS)) {
      if (raw.prompts?.[key] === undefined) continue;
      const text = String(raw.prompts[key] ?? '').slice(
        0,
        DISTILL_PROMPT_MAX + 1,
      );
      if (text.length > DISTILL_PROMPT_MAX)
        throw refuse(`A prompt is at most ${DISTILL_PROMPT_MAX} characters.`);
      // Empty, or the default itself, means the default.
      if (!text.trim() || text.trim() === DISTILL_DEFAULT_PROMPTS[key])
        delete prompts[key];
      else prompts[key] = text;
    }
  }
  const pick =
    raw.pick === undefined ? current.pick || 'best-graded' : String(raw.pick);
  if (!DISTILL_PICKS.includes(pick))
    throw refuse('GROUND TRUTH is best graded or written by a reviewer.');
  const turn3From =
    raw.turn3From === undefined
      ? current.turn3From || 'turn2'
      : String(raw.turn3From);
  if (!DISTILL_TURN3_FROM.includes(turn3From))
    throw refuse('Turn 3 goes to turn 2 or turn 1.');
  return {
    t1: one(raw.t1, current.t1 || ''),
    t2: one(raw.t2, current.t2 || ''),
    teachers: many(raw.teachers, current.teachers || []),
    reviewers: many(raw.reviewers, current.reviewers || []),
    review:
      raw.review === undefined ? current.review !== false : raw.review === true,
    pick,
    writer: one(raw.writer, current.writer || ''),
    turn3From,
    webSearch:
      raw.webSearch === undefined
        ? current.webSearch !== false
        : raw.webSearch === true,
    prompts,
  };
}

function cleanName(raw) {
  const name = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, DISTILL_NAME_MAX);
  if (!name) throw refuse('Name the heading first.');
  return name;
}

/**
 * @param {object} options
 * @param {string} options.root The repository.
 */
export function createDistillManager({
  root,
  dataRoot = path.join(root, '.gev-data'),
  env = process.env,
  fetchImpl = globalThis.fetch,
  spawnImpl,
  python,
  now = () => Date.now(),
  ask = askTeacher,
  roster = () => teacherRoster({ env, dataRoot }),
} = {}) {
  const home = path.join(dataRoot, 'distill');
  const stateFile = path.join(home, 'state.json');
  const read = (file, fallback) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  };
  const writeJson = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
  };
  const saved = read(stateFile, {});
  const features = Array.isArray(saved.features) ? saved.features : [];
  const save = () => writeJson(stateFile, { features });
  const folder = (id) => path.join(home, id);
  const find = (id) => {
    const feature = features.find((f) => f.id === String(id || ''));
    if (!feature) throw refuse('No such heading.', 404);
    return feature;
  };
  const questionsOf = (id) => read(path.join(folder(id), 'questions.json'), []);
  const progressOf = (id) =>
    read(path.join(folder(id), 'run.json'), { cursor: 0, done: 0, failed: 0 });
  const datasetFile = (id) => path.join(folder(id), 'dataset.jsonl');
  const datasetCount = (id) => {
    try {
      const text = fs.readFileSync(datasetFile(id), 'utf8');
      return text ? text.split('\n').filter(Boolean).length : 0;
    } catch {
      return 0;
    }
  };

  // --- The run ------------------------------------------------------------------------
  let run = { state: 'idle', featureId: null };
  let abort = null;
  let pauseWanted = false;
  let waiting = null; // { resolve, reject }
  let pasteChain = Promise.resolve();
  const busy = () => ['running', 'waiting', 'stopping'].includes(run.state);

  const teacherById = (id) => roster().find((t) => t.id === id) || null;
  const labelOf = (id) => teacherById(id)?.label || id;

  /**
   * One teacher's answer. While an app answers (its reply comes back by
   * itself) the run says so; a manual route waits for the owner's paste.
   */
  const callTeacher = async (
    teacher,
    { system, prompt, history, previous, webSearch, where },
  ) => {
    let got;
    try {
      got = await ask(teacher, {
        system,
        prompt,
        history,
        previous,
        webSearch,
        signal: abort.signal,
        env,
        fetchImpl,
        root,
        dataRoot,
        python,
        spawnImpl,
        onStep: ({ app }) => {
          run = {
            ...run,
            desktop: {
              teacher: teacher.id,
              label: teacher.label,
              app,
              ...where,
              since: now(),
            },
          };
        },
      });
    } finally {
      if (run.desktop?.teacher === teacher.id) run = { ...run, desktop: null };
    }
    run.calls = (run.calls || 0) + 1;
    if (!got.manual) return got;
    // One paste at a time, in the order they were asked for.
    const take = pasteChain.then(
      () =>
        new Promise((resolve, reject) => {
          if (abort.signal.aborted)
            return reject(
              Object.assign(new Error('Stopped'), { name: 'AbortError' }),
            );
          run = {
            ...run,
            state: 'waiting',
            pending: {
              teacher: teacher.id,
              label: teacher.label,
              route: got.route,
              app: got.app,
              sent: got.sent === true,
              prompt: got.prompt,
              ...(got.note ? { note: got.note } : {}),
              ...where,
              since: now(),
            },
          };
          waiting = { resolve, reject };
        }),
    );
    pasteChain = take.catch(() => {});
    const text = await take;
    return {
      text,
      responseId: localResponseId(text),
      model: teacher.model || '',
      route: got.route,
      tried: got.tried,
    };
  };

  const limit = async (items, fn) => {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i).then(
          (value) => ({ ok: true, value }),
          (error) => ({ ok: false, error }),
        );
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(PARALLEL, items.length) }, worker),
    );
    return out;
  };

  /** One question through a sub-heading's turns: the records to keep. */
  const runQuestion = async (feature, plan, question, n) => {
    const cfg = feature.config;
    const prompts = { ...DISTILL_DEFAULT_PROMPTS, ...(cfg.prompts || {}) };
    const base = { system: prompts.system, webSearch: cfg.webSearch !== false };
    const turnOf = (teacherId, role, number, got) => ({
      turn: number,
      role,
      teacher: teacherId,
      label: labelOf(teacherId),
      route: got.route,
      model: got.model,
      responseId: got.responseId,
      text: got.text,
      tried: got.tried?.length ? got.tried : undefined,
      at: now(),
    });
    const record = (groundTruth, pickedBy, turns, extra = {}) => ({
      id: `${feature.id}-${n + 1}${extra.suffix ? `-${extra.suffix}` : ''}`,
      heading: feature.heading,
      feature: feature.name,
      featureId: feature.id,
      question,
      groundTruth,
      pickedBy,
      turns,
      ...(extra.grades ? { grades: extra.grades } : {}),
      class: DISTILL_CLASS,
      createdAt: now(),
    });
    if (feature.heading === 2) {
      const answerTurns = plan.turns.filter((t) => t.role === 'answer');
      const results = await limit(answerTurns, (t, i) =>
        callTeacher(teacherById(t.teacher), {
          ...base,
          prompt: question,
          where: { question: n + 1, turn: 1, answer: i + 1 },
        }),
      );
      const answers = [];
      const failures = [];
      results.forEach((r, i) => {
        if (r.ok)
          answers.push({
            ...turnOf(answerTurns[i].teacher, 'answer', 1, r.value),
            id: `R${answers.length + 1}`,
          });
        else
          failures.push(
            `${labelOf(answerTurns[i].teacher)}: ${r.error?.message || r.error}`,
          );
      });
      if (abort.signal.aborted)
        throw Object.assign(new Error('Stopped'), { name: 'AbortError' });
      if (!answers.length)
        throw new Error(failures.join('; ') || 'No teacher answered.');
      if (!cfg.review)
        return answers.map((a, i) =>
          record(a.text, 'answer', [a], {
            suffix: answers.length > 1 ? `R${i + 1}` : '',
          }),
        );
      const block = answersBlock(
        answers.map((a) => ({
          label: a.id,
          responseId: a.responseId,
          teacher: a.label,
          text: a.text,
        })),
      );
      const gradeTurns = plan.turns.filter((t) => t.role === 'grade');
      const gradeResults = await limit(gradeTurns, (t, i) =>
        callTeacher(teacherById(t.teacher), {
          ...base,
          prompt: fillPrompt(prompts.grade, { question, answers: block }),
          where: { question: n + 1, turn: 2, reviewer: i + 1 },
        }),
      );
      if (abort.signal.aborted)
        throw Object.assign(new Error('Stopped'), { name: 'AbortError' });
      const labels = answers.map((a) => a.id);
      const grades = [];
      const reviewTurns = [];
      gradeResults.forEach((r, i) => {
        if (!r.ok) return;
        const turn = turnOf(gradeTurns[i].teacher, 'grade', 2, r.value);
        reviewTurns.push(turn);
        grades.push({
          reviewer: turn.teacher,
          label: turn.label,
          ...readGrades(r.value.text, labels),
        });
      });
      if (cfg.pick === 'writer') {
        const writer = plan.turns.find((t) => t.role === 'write');
        const got = await callTeacher(teacherById(writer.teacher), {
          ...base,
          prompt: fillPrompt(prompts.write, {
            question,
            answers: block,
            reviews: reviewsBlock(
              grades.map((g) => ({ ...g, teacher: g.label })),
            ),
          }),
          where: { question: n + 1, turn: 3 },
        });
        const turn = turnOf(writer.teacher, 'write', 3, got);
        return [
          record(
            groundTruthOf(got.text),
            'writer',
            [...answers, ...reviewTurns, turn],
            { grades },
          ),
        ];
      }
      const best = bestGraded(labels, grades);
      if (!best) throw new Error('No reviewer gave a grade to read.');
      const chosen = answers.find((a) => a.id === best.label);
      return [
        record(chosen.text, 'best-graded', [...answers, ...reviewTurns], {
          grades: [
            ...grades,
            { best: best.label, mean: best.mean, votes: best.votes },
          ],
        }),
      ];
    }
    // Headings 1 and 3-7: one turn after another; a teacher's own turns go on its own conversation.
    const turns = [];
    const talks = new Map();
    for (const step of plan.turns) {
      const teacher = teacherById(step.teacher);
      const talk = talks.get(step.teacher) || { history: [], previous: null };
      let prompt = question;
      if (step.role === 'review') {
        const reviewed = turns[step.of - 1];
        prompt = fillPrompt(prompts.review, {
          question,
          responseId: reviewed.responseId,
          teacher: reviewed.label,
          response: reviewed.text,
        });
      }
      const got = await callTeacher(teacher, {
        ...base,
        prompt,
        history: talk.history,
        previous: talk.previous,
        where: { question: n + 1, turn: step.turn },
      });
      turns.push(turnOf(step.teacher, step.role, step.turn, got));
      talks.set(step.teacher, {
        history: [
          ...talk.history,
          { role: 'user', content: prompt },
          { role: 'assistant', content: got.text },
        ],
        previous: { route: got.route, responseId: got.responseId },
      });
    }
    const last = turns.at(-1);
    return [
      record(
        last.role === 'review' ? groundTruthOf(last.text) : last.text,
        plan.turns.length > 1 ? 'final-turn' : 'single',
        turns,
      ),
    ];
  };

  const runAll = async (feature, plan) => {
    const questions = questionsOf(feature.id);
    let progress = progressOf(feature.id);
    try {
      while (progress.cursor < questions.length) {
        if (pauseWanted) {
          run = { ...run, state: 'paused', pending: null };
          return;
        }
        const n = progress.cursor;
        run = {
          ...run,
          state: 'running',
          question: n + 1,
          total: questions.length,
          pending: null,
        };
        try {
          const records = await runQuestion(feature, plan, questions[n], n);
          fs.appendFileSync(
            datasetFile(feature.id),
            records.map((r) => `${JSON.stringify(r)}\n`).join(''),
          );
          progress = {
            ...progress,
            cursor: n + 1,
            done: (progress.done || 0) + 1,
          };
        } catch (error) {
          if (abort.signal.aborted) throw error;
          run.errors = [
            {
              question: n + 1,
              error: String(error?.message || error).slice(0, 400),
              at: now(),
            },
            ...(run.errors || []),
          ].slice(0, ERRORS_KEPT);
          progress = {
            ...progress,
            cursor: n + 1,
            failed: (progress.failed || 0) + 1,
          };
        }
        writeJson(path.join(folder(feature.id), 'run.json'), {
          ...progress,
          updatedAt: now(),
        });
      }
      run = { ...run, state: 'done', pending: null, endedAt: now() };
    } catch (error) {
      run = {
        ...run,
        state: error?.name === 'AbortError' ? 'stopped' : 'error',
        error:
          error?.name === 'AbortError' ? null : String(error?.message || error),
        pending: null,
        endedAt: now(),
      };
    } finally {
      waiting = null;
      pasteChain = Promise.resolve();
    }
  };

  const plannedFor = (feature) => {
    const plan = planTurns(feature.heading, feature.config);
    if (!plan.ok) throw refuse(plan.error);
    const teachers = new Map(roster().map((t) => [t.id, t]));
    for (const t of plan.turns) {
      const teacher = teachers.get(t.teacher);
      if (!teacher) throw refuse(`Unknown teacher: ${t.teacher}.`);
      if (!teacher.ready)
        throw refuse(
          `${teacher.label} is not set up: add its key in POWER UP.`,
        );
    }
    return plan;
  };

  const featureView = (f) => {
    const progress = progressOf(f.id);
    const questions = questionsOf(f.id);
    return {
      id: f.id,
      heading: f.heading,
      name: f.name,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
      config: f.config,
      questions: questions.length,
      preview: questions.slice(0, 5).map((q) => q.slice(0, 200)),
      cursor: Math.min(progress.cursor || 0, questions.length),
      done: progress.done || 0,
      failed: progress.failed || 0,
      records: datasetCount(f.id),
    };
  };

  const manager = {
    started: Promise.resolve(),
    status() {
      const teachers = roster();
      return {
        headings: DISTILL_HEADINGS,
        teachers,
        prompts: DISTILL_DEFAULT_PROMPTS,
        features: features.map(featureView),
        run: { ...run, busy: busy() },
        datasetClass: DISTILL_CLASS,
      };
    },
    addFeature({ heading, name } = {}) {
      const h = Number(heading);
      if (!DISTILL_HEADINGS.some((d) => d.id === h))
        throw refuse('Unknown heading.');
      const feature = {
        id: `h${h}-${crypto.randomBytes(5).toString('hex')}`,
        heading: h,
        name: cleanName(name),
        createdAt: now(),
        updatedAt: now(),
        config: cleanConfig({}, { review: true }, []),
      };
      features.push(feature);
      fs.mkdirSync(folder(feature.id), { recursive: true });
      save();
      return manager.status();
    },
    updateFeature({ id, name, config } = {}) {
      const feature = find(id);
      if (run.featureId === feature.id && busy())
        throw refuse('Stop its run before changing it.', 409);
      if (name !== undefined) feature.name = cleanName(name);
      if (config !== undefined)
        feature.config = cleanConfig(
          config,
          feature.config,
          roster().map((t) => t.id),
        );
      feature.updatedAt = now();
      save();
      return manager.status();
    },
    removeFeature({ id } = {}) {
      const feature = find(id);
      if (run.featureId === feature.id && busy())
        throw refuse('Stop its run first.', 409);
      features.splice(features.indexOf(feature), 1);
      fs.rmSync(folder(feature.id), { recursive: true, force: true });
      if (run.featureId === feature.id)
        run = { state: 'idle', featureId: null };
      save();
      return manager.status();
    },
    addQuestions({ id, text, csv } = {}) {
      const feature = find(id);
      if (run.featureId === feature.id && busy())
        throw refuse('Pause its run before adding questions.', 409);
      if (csv !== undefined && String(csv).length > CSV_BYTES)
        throw refuse('A CSV file is at most 4 MB.', 413);
      const added =
        csv !== undefined ? questionsFromCsv(csv) : questionsFromText(text);
      if (!added.length)
        throw refuse(
          csv !== undefined
            ? 'No questions in that CSV file.'
            : 'Type a question first.',
        );
      const long = added.find((q) => q.length > DISTILL_QUESTION_MAX);
      if (long)
        throw refuse(
          `A question is at most ${DISTILL_QUESTION_MAX} characters.`,
        );
      const questions = questionsOf(feature.id);
      const seen = new Set(questions);
      for (const q of added) {
        if (seen.has(q)) continue;
        seen.add(q);
        questions.push(q);
      }
      if (questions.length > DISTILL_QUESTIONS_MAX)
        throw refuse(
          `A heading holds at most ${DISTILL_QUESTIONS_MAX} questions.`,
        );
      writeJson(path.join(folder(feature.id), 'questions.json'), questions);
      return manager.status();
    },
    clearQuestions({ id } = {}) {
      const feature = find(id);
      if (run.featureId === feature.id && busy())
        throw refuse('Stop its run first.', 409);
      writeJson(path.join(folder(feature.id), 'questions.json'), []);
      writeJson(path.join(folder(feature.id), 'run.json'), {
        cursor: 0,
        done: 0,
        failed: 0,
        updatedAt: now(),
      });
      return manager.status();
    },
    clearDataset({ id } = {}) {
      const feature = find(id);
      if (run.featureId === feature.id && busy())
        throw refuse('Stop its run first.', 409);
      fs.rmSync(datasetFile(feature.id), { force: true });
      return manager.status();
    },
    estimate({ id, fresh = false } = {}) {
      const feature = find(id);
      const plan = plannedFor(feature);
      const questions = questionsOf(feature.id);
      const cursor = fresh
        ? 0
        : Math.min(progressOf(feature.id).cursor || 0, questions.length);
      const manual = roster()
        .filter((t) => t.manualOnly)
        .map((t) => t.id);
      return {
        ...estimateRun({
          turns: plan.turns,
          questionsLeft: questions.length - cursor,
          manual,
        }),
        from: cursor + 1,
        turns: plan.turns.map((t) => ({ ...t, label: labelOf(t.teacher) })),
      };
    },
    start({ id, confirm = false, fresh = false } = {}) {
      if (busy()) throw refuse('A distillation run is going already.', 409);
      const feature = find(id);
      const plan = plannedFor(feature);
      const questions = questionsOf(feature.id);
      if (!questions.length) throw refuse('Add questions first.');
      if (fresh)
        writeJson(path.join(folder(feature.id), 'run.json'), {
          cursor: 0,
          done: 0,
          failed: 0,
          updatedAt: now(),
        });
      if (progressOf(feature.id).cursor >= questions.length)
        throw refuse(
          'Every question is done. Add questions, or start over.',
          409,
        );
      if (confirm !== true) throw refuse('Confirm the estimate first.', 409);
      abort = new AbortController();
      pauseWanted = false;
      run = {
        state: 'running',
        featureId: feature.id,
        heading: feature.heading,
        name: feature.name,
        startedAt: now(),
        calls: 0,
        errors: [],
      };
      manager.started = runAll(feature, plan);
      return manager.status();
    },
    pause() {
      if (!busy()) throw refuse('Nothing is running.', 409);
      pauseWanted = true;
      run = { ...run, pauseWanted: true };
      return manager.status();
    },
    continue() {
      if (run.state !== 'paused' && run.state !== 'stopped')
        throw refuse('Nothing is paused.', 409);
      return manager.start({ id: run.featureId, confirm: true });
    },
    stop() {
      if (!busy()) {
        if (run.state === 'paused') run = { ...run, state: 'stopped' };
        return manager.status();
      }
      run = { ...run, state: 'stopping' };
      abort?.abort();
      waiting?.reject(
        Object.assign(new Error('Stopped'), { name: 'AbortError' }),
      );
      waiting = null;
      return manager.status();
    },
    paste({ answer } = {}) {
      if (run.state !== 'waiting' || !waiting)
        throw refuse('Nothing is waiting for a paste.', 409);
      const text = String(answer ?? '').trim();
      if (!text) throw refuse('Paste the answer first.');
      const done = waiting;
      waiting = null;
      run = { ...run, state: 'running', pending: null };
      done.resolve(text.slice(0, 40_000));
      return manager.status();
    },
    skipPaste() {
      if (run.state !== 'waiting' || !waiting)
        throw refuse('Nothing is waiting for a paste.', 409);
      const done = waiting;
      waiting = null;
      run = { ...run, state: 'running', pending: null };
      done.reject(new Error('Skipped: no answer was pasted.'));
      return manager.status();
    },
    /** The dataset as a download: JSONL as kept, or CSV of the ground truths. */
    exportData({ id, format = 'jsonl' } = {}) {
      const feature = find(id);
      let text = '';
      try {
        text = fs.readFileSync(datasetFile(feature.id), 'utf8');
      } catch {
        text = '';
      }
      const slug =
        feature.name
          .replace(/[^A-Za-z0-9_-]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 40) || feature.id;
      if (format !== 'csv')
        return {
          body: text,
          type: 'application/x-ndjson; charset=utf-8',
          filename: `distill-${slug}.jsonl`,
        };
      const rows = [
        [
          'id',
          'heading',
          'question',
          'ground_truth',
          'picked_by',
          'teachers',
          'class',
        ],
      ];
      for (const line of text.split('\n').filter(Boolean)) {
        let r;
        try {
          r = JSON.parse(line);
        } catch {
          continue;
        }
        rows.push([
          r.id,
          r.heading,
          r.question,
          r.groundTruth,
          r.pickedBy,
          [...new Set((r.turns || []).map((t) => t.label))].join(' | '),
          r.class,
        ]);
      }
      return {
        body: `${rows.map((row) => row.map(csvField).join(',')).join('\r\n')}\r\n`,
        type: 'text/csv; charset=utf-8',
        filename: `distill-${slug}.csv`,
      };
    },
    close() {
      abort?.abort();
      waiting?.reject(
        Object.assign(new Error('Stopped'), { name: 'AbortError' }),
      );
    },
  };
  return manager;
}
