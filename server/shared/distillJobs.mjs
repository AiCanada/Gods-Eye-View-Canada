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
 *   run.json         how far the run got (a run continues from there), the
 *                    questions that failed, and the ones a retry still owes
 *
 * One run goes at a time, one question at a time (heading 2 asks its teachers
 * three at a time). A teacher whose only route left needs the owner (the Chief
 * of Staff webhook, the Grok Bot or ChatGPT app) holds the run as WAITING
 * until its reply is pasted back or skipped. PAUSE finishes the question it
 * is on; STOP drops it; CONTINUE picks up at the next question. A run may
 * also go over the failed questions again (RETRY THE FAILED QUESTIONS) or
 * stop by itself after one question (ONE QUESTION, THEN PAUSE), to try the
 * prompts before paying for the rest.
 *
 * The status carries, per sub-heading, what its dataset holds: the count,
 * each student's mean grade, and the last record, read once per appended
 * record (the file only ever grows), so a poll never re-reads a dataset.
 *
 * A sub-heading may pick students too (owner request 2026-10-21): they
 * answer the question first, three at a time, and the heading's first
 * teacher turn grades each student answer, fixes its errors and writes the
 * upgraded answer (src/distillCore.mjs, planTurns). The record keeps the
 * students' answers as turn 0 and each teacher's grades as `studentGrades`.
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

/** A text on one line, its spaces collapsed, for the status. */
const flat = (text) =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
/** Up to `max` characters of a text, and whether it was cut. */
function clip(text, max) {
  return text.length > max
    ? { text: `${text.slice(0, max - 1)}…`, cut: true }
    : { text, cut: false };
}

/** The question number a record id carries: <feature id>-<n>[-R1]. */
function questionNumberOf(id, featureId) {
  const text = String(id ?? '');
  const prefix = `${featureId}-`;
  if (!text.startsWith(prefix)) return 0;
  const match = /^(\d+)(?:-|$)/.exec(text.slice(prefix.length));
  return match ? Number(match[1]) : 0;
}

/** Question numbers (1-based) from a run.json list. */
function numbers(value) {
  return Array.isArray(value)
    ? [
        ...new Set(
          value.map(Number).filter((n) => Number.isInteger(n) && n > 0),
        ),
      ].sort((a, b) => a - b)
    : [];
}

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
    students: many(raw.students, current.students || []),
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
  /**
   * How far a sub-heading's run got: the next question (`cursor`), the
   * counts, the questions that failed (1-based numbers) and the ones the
   * retry under way still owes.
   */
  const progressOf = (id) => {
    const p = read(path.join(folder(id), 'run.json'), {});
    return {
      cursor: Math.max(0, Math.floor(Number(p.cursor)) || 0),
      done: Math.max(0, Math.floor(Number(p.done)) || 0),
      failed: Math.max(0, Math.floor(Number(p.failed)) || 0),
      failedQuestions: numbers(p.failedQuestions),
      retryQueue: numbers(p.retryQueue),
    };
  };
  const freshProgress = () => ({
    cursor: 0,
    done: 0,
    failed: 0,
    failedQuestions: [],
    retryQueue: [],
  });
  const saveProgress = (id, progress) =>
    writeJson(path.join(folder(id), 'run.json'), {
      ...progress,
      updatedAt: now(),
    });
  const datasetFile = (id) => path.join(folder(id), 'dataset.jsonl');

  // --- What a dataset holds, read as it grows ---------------------------------------
  const statsCache = new Map();
  const emptyStats = () => ({
    offset: 0, // bytes of the file taken in so far
    rest: Buffer.alloc(0), // the bytes after the last line break: a write under way
    records: 0,
    last: null,
    students: new Map(),
  });
  const studentsOf = (turns) =>
    new Map(
      turns.filter((t) => t?.role === 'student' && t.id).map((t) => [t.id, t]),
    );
  /** The grades a record's teachers gave its students, as lines, with their numbers. */
  const gradesOf = (r, studentsById) => {
    const out = [];
    for (const g of Array.isArray(r.studentGrades) ? r.studentGrades : [])
      for (const [sid, raw] of Object.entries(g?.scores || {})) {
        const score = Number(raw);
        const student = studentsById.get(sid);
        if (student && Number.isFinite(score))
          out.push({
            teacher: student.teacher,
            score,
            text: `${student.label}: ${score}/10 (${g.label})`,
          });
      }
    return out;
  };
  /**
   * A record as the tab shows it: the texts (their heads on one line for
   * the status, as written up to `question` and `truth` characters with
   * `lines`), who took part, who did not answer, and the grades; `more`
   * says a text was cut.
   */
  const recordView = (
    r,
    featureId,
    { question = 300, truth = 600, lines = false } = {},
  ) => {
    const turns = Array.isArray(r.turns) ? r.turns : [];
    const studentsById = studentsOf(turns);
    const text = (value) => (lines ? String(value ?? '').trim() : flat(value));
    const q = clip(text(r.question), question);
    const g = clip(text(r.groundTruth), truth);
    return {
      id: r.id,
      questionNumber: questionNumberOf(r.id, featureId),
      question: q.text,
      groundTruth: g.text,
      more: q.cut || g.cut,
      pickedBy: r.pickedBy,
      teachers: [
        ...new Set(
          turns.filter((t) => t?.role !== 'student').map((t) => t.label),
        ),
      ],
      students: [...new Set([...studentsById.values()].map((t) => t.label))],
      failed: [
        ...new Set(
          (Array.isArray(r.failures) ? r.failures : [])
            .map((f) => f?.label)
            .filter(Boolean),
        ),
      ],
      grades: gradesOf(r, studentsById).map((g) => g.text),
      createdAt: r.createdAt,
    };
  };
  const noteRecord = (cache, r, featureId) => {
    cache.records += 1;
    const turns = Array.isArray(r.turns) ? r.turns : [];
    const studentsById = studentsOf(turns);
    for (const t of studentsById.values()) {
      const s = cache.students.get(t.teacher) || {
        teacher: t.teacher,
        label: t.label,
        answers: 0,
        graded: 0,
        sum: 0,
      };
      s.answers += 1;
      cache.students.set(t.teacher, s);
    }
    for (const g of gradesOf(r, studentsById)) {
      const s = cache.students.get(g.teacher);
      s.graded += 1;
      s.sum += g.score;
    }
    cache.last = recordView(r, featureId);
  };
  /**
   * The dataset's count, each student's mean grade and the last record. The
   * file only grows, so only the bytes since the last look are read; a
   * shorter file (cleared, or a record dropped) is read again from the start.
   */
  const statsOf = (id) => {
    const file = datasetFile(id);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      statsCache.delete(id);
      return { records: 0, last: null, students: [] };
    }
    let cache = statsCache.get(id);
    if (!cache || stat.size < cache.offset) cache = emptyStats();
    if (stat.size > cache.offset) {
      const fd = fs.openSync(file, 'r');
      try {
        const length = stat.size - cache.offset;
        const buffer = Buffer.alloc(length);
        const got = fs.readSync(fd, buffer, 0, length, cache.offset);
        const bytes = Buffer.concat([cache.rest, buffer.subarray(0, got)]);
        const cut = bytes.lastIndexOf(0x0a) + 1; // whole lines end at the last line break
        for (const line of bytes.toString('utf8', 0, cut).split('\n')) {
          if (!line.trim()) continue;
          let r;
          try {
            r = JSON.parse(line);
          } catch {
            continue;
          }
          if (r && typeof r === 'object') noteRecord(cache, r, id);
        }
        cache.rest = Buffer.from(bytes.subarray(cut));
        cache.offset += got;
      } finally {
        fs.closeSync(fd);
      }
    }
    statsCache.set(id, cache);
    return {
      records: cache.records,
      last: cache.last,
      students: [...cache.students.values()].map((s) => ({
        teacher: s.teacher,
        label: s.label,
        answers: s.answers,
        graded: s.graded,
        mean: s.graded ? Math.round((s.sum / s.graded) * 10) / 10 : null,
      })),
    };
  };

  /** The dataset's records, one JSON line each. */
  const recordLines = (id) => {
    try {
      return fs
        .readFileSync(datasetFile(id), 'utf8')
        .split('\n')
        .filter((line) => line.trim());
    } catch {
      return [];
    }
  };
  const writeDataset = (id, lines) => {
    const file = datasetFile(id);
    statsCache.delete(id);
    if (!lines.length) {
      fs.rmSync(file, { force: true });
      return;
    }
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, lines.map((line) => `${line}\n`).join(''));
    fs.renameSync(tmp, file);
  };

  // --- The run ------------------------------------------------------------------------
  let run = { state: 'idle', featureId: null };
  let abort = null;
  let pauseWanted = false;
  let carry = null; // the paused run CONTINUE goes on with: its calls and errors stay
  let waiting = null; // { resolve, reject }
  let pasteChain = Promise.resolve();
  const active = []; // the calls under way, oldest first: the line names the latest
  const busy = () => ['running', 'waiting', 'stopping'].includes(run.state);

  const teacherById = (id) => roster().find((t) => t.id === id) || null;
  const labelOf = (id) => teacherById(id)?.label || id;

  /**
   * One teacher's answer. While an app answers (its reply comes back by
   * itself) the run says so; a manual route waits for the owner's paste.
   */
  const callTeacher = async (
    teacherId,
    { system, prompt, history, previous, webSearch, where },
  ) => {
    // The list is read again for every call: a key added since counts, and
    // a custom LLM deleted since is a plain failure of its turn.
    const teacher = teacherById(teacherId);
    if (!teacher) throw new Error(`${teacherId} is not on the list any more.`);
    let got;
    // The line says who is answering now (the latest asked, when several are).
    const current = { teacher: teacher.id, label: teacher.label, ...where };
    active.push(current);
    run = { ...run, now: current };
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
      active.splice(active.indexOf(current), 1);
      run = { ...run, now: active.at(-1) || null };
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
    // Who did not answer (a student, or one of heading 2's teachers or
    // reviewers) while the question still went through: kept on the record.
    const missed = [];
    const record = (groundTruth, pickedBy, turns, extra = {}) => ({
      id: `${feature.id}-${n + 1}${extra.suffix ? `-${extra.suffix}` : ''}`,
      heading: feature.heading,
      feature: feature.name,
      featureId: feature.id,
      question,
      groundTruth,
      pickedBy,
      turns,
      ...(extra.studentGrades ? { studentGrades: extra.studentGrades } : {}),
      ...(extra.grades ? { grades: extra.grades } : {}),
      ...(missed.length ? { failures: missed } : {}),
      class: DISTILL_CLASS,
      createdAt: now(),
    });
    const stopped = () => {
      if (abort.signal.aborted)
        throw Object.assign(new Error('Stopped'), { name: 'AbortError' });
    };
    const failureOf = (role, teacherId, r) => {
      const failure = {
        role,
        teacher: teacherId,
        label: labelOf(teacherId),
        error: String(r.error?.message || r.error).slice(0, 400),
      };
      missed.push(failure);
      return `${failure.label}: ${failure.error}`;
    };

    // The students answer the question first (three at a time); the teachers'
    // first turn then grades their answers, fixes the errors and upgrades them.
    const studentTurns = plan.turns.filter((t) => t.role === 'student');
    const students = [];
    if (studentTurns.length) {
      const results = await limit(studentTurns, (t, i) =>
        callTeacher(t.teacher, {
          ...base,
          prompt: question,
          where: { question: n + 1, turn: 0, student: i + 1 },
        }),
      );
      const failures = [];
      results.forEach((r, i) => {
        if (r.ok)
          students.push({
            ...turnOf(studentTurns[i].teacher, 'student', 0, r.value),
            id: `S${students.length + 1}`,
          });
        else failures.push(failureOf('student', studentTurns[i].teacher, r));
      });
      stopped();
      if (!students.length)
        throw new Error(`No student answered: ${failures.join('; ')}`);
    }
    const studentIds = students.map((s) => s.id);
    const studentsBlock = answersBlock(
      students.map((s) => ({
        label: s.id,
        responseId: s.responseId,
        teacher: s.label,
        text: s.text,
      })),
    );
    /** A teacher's first turn: the question cold, or the students' answers to grade and upgrade. */
    const firstPrompt = (role) =>
      role === 'upgrade'
        ? fillPrompt(prompts.upgrade, { question, answers: studentsBlock })
        : question;
    /** The answer a turn gives: an upgrade's comes after its grades. */
    const answerOf = (turn) =>
      turn.role === 'upgrade' ? groundTruthOf(turn.text) : turn.text;
    /** The grades a teacher gave the students in its upgrade turn. */
    const studentGradesOf = (turn) => {
      const { scores, critiques } = readGrades(turn.text, studentIds);
      return { teacher: turn.teacher, label: turn.label, scores, critiques };
    };
    const withStudents = (turns) =>
      students.length
        ? {
            studentGrades: turns
              .filter((t) => t.role === 'upgrade')
              .map(studentGradesOf),
          }
        : {};

    if (feature.heading === 2) {
      const answerTurns = plan.turns.filter(
        (t) => t.role === 'answer' || t.role === 'upgrade',
      );
      const results = await limit(answerTurns, (t, i) =>
        callTeacher(t.teacher, {
          ...base,
          prompt: firstPrompt(t.role),
          where: { question: n + 1, turn: 1, answer: i + 1 },
        }),
      );
      const answers = [];
      const failures = [];
      results.forEach((r, i) => {
        if (r.ok)
          answers.push({
            ...turnOf(answerTurns[i].teacher, answerTurns[i].role, 1, r.value),
            id: `R${answers.length + 1}`,
          });
        else
          failures.push(
            failureOf(answerTurns[i].role, answerTurns[i].teacher, r),
          );
      });
      stopped();
      if (!answers.length)
        throw new Error(failures.join('; ') || 'No teacher answered.');
      if (!cfg.review)
        return answers.map((a, i) =>
          record(
            answerOf(a),
            a.role === 'upgrade' ? 'upgrade' : 'answer',
            [...students, a],
            {
              suffix: answers.length > 1 ? `R${i + 1}` : '',
              ...withStudents([a]),
            },
          ),
        );
      const block = answersBlock(
        answers.map((a) => ({
          label: a.id,
          responseId: a.responseId,
          teacher: a.label,
          text: answerOf(a),
        })),
      );
      const gradeTurns = plan.turns.filter((t) => t.role === 'grade');
      const gradeResults = await limit(gradeTurns, (t, i) =>
        callTeacher(t.teacher, {
          ...base,
          prompt: fillPrompt(prompts.grade, { question, answers: block }),
          where: { question: n + 1, turn: 2, reviewer: i + 1 },
        }),
      );
      stopped();
      const labels = answers.map((a) => a.id);
      const grades = [];
      const reviewTurns = [];
      const gradeFailures = [];
      gradeResults.forEach((r, i) => {
        if (!r.ok) {
          gradeFailures.push(failureOf('grade', gradeTurns[i].teacher, r));
          return;
        }
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
        const got = await callTeacher(writer.teacher, {
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
            [...students, ...answers, ...reviewTurns, turn],
            { grades, ...withStudents(answers) },
          ),
        ];
      }
      const best = bestGraded(labels, grades);
      if (!best)
        throw new Error(
          gradeFailures.length
            ? `No reviewer gave a grade to read: ${gradeFailures.join('; ')}`
            : 'No reviewer gave a grade to read.',
        );
      const chosen = answers.find((a) => a.id === best.label);
      return [
        record(
          answerOf(chosen),
          'best-graded',
          [...students, ...answers, ...reviewTurns],
          {
            grades: [
              ...grades,
              { best: best.label, mean: best.mean, votes: best.votes },
            ],
            ...withStudents(answers),
          },
        ),
      ];
    }
    // Headings 1 and 3-7: one turn after another; a teacher's own turns go on its own conversation.
    const turns = [];
    const talks = new Map();
    for (const step of plan.turns) {
      if (step.role === 'student') continue;
      const talk = talks.get(step.teacher) || { history: [], previous: null };
      let prompt = firstPrompt(step.role);
      if (step.role === 'review') {
        const reviewed = turns[step.of - 1];
        prompt = fillPrompt(prompts.review, {
          question,
          responseId: reviewed.responseId,
          teacher: reviewed.label,
          response: reviewed.text,
        });
      }
      const got = await callTeacher(step.teacher, {
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
        last.role === 'review' || last.role === 'upgrade'
          ? groundTruthOf(last.text)
          : last.text,
        last.role === 'upgrade'
          ? 'upgrade'
          : turns.length > 1
            ? 'final-turn'
            : 'single',
        [...students, ...turns],
        withStudents(turns),
      ),
    ];
  };

  /**
   * One question's outcome into the progress: ahead of the cursor, or off
   * the retry queue. A failed question is listed; one that passes on a retry
   * is taken off the list.
   */
  const advance = (progress, n, ok, retry) => {
    const number = n + 1;
    const failedQuestions = numbers([
      ...progress.failedQuestions.filter((q) => q !== number),
      ...(ok ? [] : [number]),
    ]);
    if (retry)
      return {
        ...progress,
        retryQueue: progress.retryQueue.filter((q) => q !== number),
        done: ok ? progress.done + 1 : progress.done,
        failed: ok ? Math.max(0, progress.failed - 1) : progress.failed,
        failedQuestions,
      };
    return {
      ...progress,
      cursor: n + 1,
      done: ok ? progress.done + 1 : progress.done,
      failed: ok ? progress.failed : progress.failed + 1,
      failedQuestions,
    };
  };

  /**
   * The run: ahead of the cursor, or over the retry queue (`retry`). PAUSE
   * and `pauseAfter` (ONE QUESTION, THEN PAUSE) stop it between questions.
   */
  const runAll = async (feature, plan, { retry = false, pauseAfter = 0 }) => {
    const questions = questionsOf(feature.id);
    let progress = progressOf(feature.id);
    const passTotal = retry ? progress.retryQueue.length : 0;
    let ran = 0;
    const next = () =>
      retry
        ? progress.retryQueue.length
          ? progress.retryQueue[0] - 1
          : -1
        : progress.cursor < questions.length
          ? progress.cursor
          : -1;
    try {
      for (let n = next(); n >= 0 && n < questions.length; n = next()) {
        if (pauseWanted) {
          run = {
            ...run,
            state: 'paused',
            pending: null,
            now: null,
            pauseWanted: false,
          };
          return;
        }
        run = {
          ...run,
          state: 'running',
          question: n + 1,
          total: questions.length,
          pending: null,
          ...(retry ? { retryAt: ran + 1, retryOf: passTotal } : {}),
        };
        let ok = false;
        try {
          const records = await runQuestion(feature, plan, questions[n], n);
          fs.appendFileSync(
            datasetFile(feature.id),
            records.map((r) => `${JSON.stringify(r)}\n`).join(''),
          );
          ok = true;
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
        }
        progress = advance(progress, n, ok, retry);
        saveProgress(feature.id, progress);
        ran += 1;
        if (pauseAfter > 0 && ran >= pauseAfter) pauseWanted = true;
      }
      run = { ...run, state: 'done', pending: null, now: null, endedAt: now() };
    } catch (error) {
      run = {
        ...run,
        state: error?.name === 'AbortError' ? 'stopped' : 'error',
        error:
          error?.name === 'AbortError' ? null : String(error?.message || error),
        pending: null,
        now: null,
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
    const stats = statsOf(f.id);
    return {
      id: f.id,
      heading: f.heading,
      name: f.name,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
      config: f.config,
      questions: questions.length,
      preview: questions.slice(0, 5).map((q) => q.slice(0, 200)),
      cursor: Math.min(progress.cursor, questions.length),
      done: progress.done,
      failed: progress.failed,
      failedQuestions: progress.failedQuestions,
      records: stats.records,
      last: stats.last,
      students: stats.students,
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
      let fresh = 0;
      for (const q of added) {
        if (seen.has(q)) continue;
        seen.add(q);
        questions.push(q);
        fresh += 1;
      }
      // A question is kept once; nothing new is said, not done in silence.
      if (!fresh)
        throw refuse(
          added.length > 1
            ? 'Those questions are there already.'
            : 'That question is there already.',
        );
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
      saveProgress(feature.id, freshProgress());
      return manager.status();
    },
    clearDataset({ id } = {}) {
      const feature = find(id);
      if (run.featureId === feature.id && busy())
        throw refuse('Stop its run first.', 409);
      writeDataset(feature.id, []);
      return manager.status();
    },
    /** One record to look at, counted back from the newest (`at` 0 is the last). */
    record({ id, at = 0 } = {}) {
      const feature = find(id);
      const lines = recordLines(feature.id);
      const back = Math.max(0, Math.floor(Number(at)) || 0);
      const index = lines.length - 1 - back;
      let r = null;
      if (index >= 0)
        try {
          r = JSON.parse(lines[index]);
        } catch {
          r = null;
        }
      return {
        total: lines.length,
        at: back,
        record:
          r && typeof r === 'object'
            ? recordView(r, feature.id, {
                question: 4000,
                truth: 8000,
                lines: true,
              })
            : null,
      };
    },
    /**
     * Drop the records of the question a record belongs to (every answer of
     * it in heading 2) and list that question as failed, so RETRY does it
     * again. PC only, as every removal is.
     */
    dropRecords({ id, at = 0 } = {}) {
      const feature = find(id);
      if (run.featureId === feature.id && busy())
        throw refuse('Stop its run first.', 409);
      const lines = recordLines(feature.id);
      const back = Math.max(0, Math.floor(Number(at)) || 0);
      const index = lines.length - 1 - back;
      if (index < 0) throw refuse('No such record.', 404);
      const numberOf = (line) => {
        try {
          return questionNumberOf(JSON.parse(line)?.id, feature.id);
        } catch {
          return 0;
        }
      };
      const number = numberOf(lines[index]);
      writeDataset(
        feature.id,
        number
          ? lines.filter((line) => numberOf(line) !== number)
          : lines.filter((_, i) => i !== index),
      );
      const progress = progressOf(feature.id);
      if (
        number &&
        number <= questionsOf(feature.id).length &&
        !progress.failedQuestions.includes(number)
      )
        saveProgress(feature.id, {
          ...progress,
          done: Math.max(0, progress.done - 1),
          failed: progress.failed + 1,
          failedQuestions: numbers([...progress.failedQuestions, number]),
        });
      return manager.status();
    },
    /** The paid calls a run would make: ahead, from the start (`fresh`), or over the failed questions (`retry`). */
    estimate({ id, fresh = false, retry = false } = {}) {
      const feature = find(id);
      const plan = plannedFor(feature);
      const questions = questionsOf(feature.id);
      const progress = progressOf(feature.id);
      const cursor = fresh ? 0 : Math.min(progress.cursor, questions.length);
      const failed = progress.failedQuestions.filter(
        (q) => q <= questions.length,
      );
      const manual = roster()
        .filter((t) => t.manualOnly)
        .map((t) => t.id);
      return {
        ...estimateRun({
          turns: plan.turns,
          questionsLeft: retry ? failed.length : questions.length - cursor,
          manual,
        }),
        from: retry ? failed[0] || 0 : cursor + 1,
        mode: retry ? 'retry' : 'ahead',
        turns: plan.turns.map((t) => ({ ...t, label: labelOf(t.teacher) })),
      };
    },
    /**
     * Start, after CONFIRM: ahead of the cursor; from question 1 (`fresh`);
     * or over the failed questions (`retry`, continuing a retry under way
     * when CONTINUE asks). `pauseAfter` pauses after that many questions.
     * `calls`, when given, is the count the owner confirmed: a run that
     * would cost another (settings saved or questions added since) asks
     * for ESTIMATE again.
     */
    start({
      id,
      confirm = false,
      fresh = false,
      retry = false,
      pauseAfter = 0,
      calls,
    } = {}) {
      if (busy()) throw refuse('A distillation run is going already.', 409);
      const feature = find(id);
      const plan = plannedFor(feature);
      const questions = questionsOf(feature.id);
      if (!questions.length) throw refuse('Add questions first.');
      if (fresh && retry)
        throw refuse('Start over or retry the failed questions: not both.');
      const progress = progressOf(feature.id);
      const resumed = carry?.featureId === feature.id ? carry : null;
      const queue = retry
        ? resumed && progress.retryQueue.length
          ? progress.retryQueue
          : progress.failedQuestions
        : [];
      if (retry && !queue.length)
        throw refuse('No failed questions to retry.', 409);
      if (!retry && !fresh && progress.cursor >= questions.length)
        throw refuse(
          'Every question is done. Add questions, or start over.',
          409,
        );
      // Nothing changes before the estimate is confirmed, not even START OVER.
      if (confirm !== true) throw refuse('Confirm the estimate first.', 409);
      if (
        calls !== undefined &&
        Number(calls) !== manager.estimate({ id, fresh, retry }).calls
      )
        throw refuse('The estimate changed: press ESTIMATE again.', 409);
      const once = Math.max(0, Math.floor(Number(pauseAfter)) || 0);
      if (fresh) saveProgress(feature.id, freshProgress());
      else if (retry)
        saveProgress(feature.id, { ...progress, retryQueue: queue });
      abort = new AbortController();
      pauseWanted = false;
      run = {
        state: 'running',
        featureId: feature.id,
        heading: feature.heading,
        name: feature.name,
        retry: retry === true,
        ...(once ? { pauseAfter: once } : {}),
        startedAt: resumed?.startedAt || now(),
        calls: resumed?.calls || 0,
        errors: resumed?.errors || [],
      };
      manager.started = runAll(feature, plan, { retry, pauseAfter: once });
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
      // The same run goes on: its calls and errors so far stay on the line,
      // and a retry picks up the questions it still owes.
      carry = run;
      try {
        return manager.start({
          id: run.featureId,
          confirm: true,
          retry: run.retry === true,
        });
      } finally {
        carry = null;
      }
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
          'students',
          'student_grades',
          'class',
        ],
      ];
      const names = (turns) => [...new Set(turns.map((t) => t.label))];
      for (const line of text.split('\n').filter(Boolean)) {
        let r;
        try {
          r = JSON.parse(line);
        } catch {
          continue;
        }
        const turns = Array.isArray(r.turns) ? r.turns : [];
        rows.push([
          r.id,
          r.heading,
          r.question,
          r.groundTruth,
          r.pickedBy,
          names(turns.filter((t) => t.role !== 'student')).join(' | '),
          names(turns.filter((t) => t.role === 'student')).join(' | '),
          (r.studentGrades || [])
            .flatMap((g) =>
              Object.entries(g.scores || {}).map(
                ([id, score]) => `${id}: ${score}/10 (${g.label})`,
              ),
            )
            .join(' | '),
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
