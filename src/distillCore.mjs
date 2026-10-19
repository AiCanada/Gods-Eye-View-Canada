/**
 * AI DISTILLATION, the rules both sides share (owner request 2026-10-19):
 * the seven headings, the turns each one asks of its teachers, the prompts,
 * CSV questions, reading a reviewer's grades, and how many paid calls a run
 * makes. No DOM, no network: server/shared/distillJobs.mjs runs the turns,
 * src/distillPanel.js shows them.
 *
 * A heading holds any number of the owner's own sub-headings (each one a
 * saved run: its name, questions, teachers, prompts and dataset). Every run
 * goes one question at a time and ends each question with a ground truth
 * answer to train off of.
 */
import { msgl } from './i18n/marker.js';

/** The seven headings, in the owner's words (2026-10-19). */
export const DISTILL_HEADINGS = Object.freeze([
  Object.freeze({
    id: 1,
    title: msgl('1. One Question at a time- One Answer/one teacher'),
    note: msgl(
      'One LLM or bot answers each question, from the box or a CSV file. Its answer is the ground truth to train off of.',
    ),
  }),
  Object.freeze({
    id: 2,
    title: msgl(
      '2. One Question at a time- Multiple Graded Answers/multiple teachers adversarial review',
    ),
    note: msgl(
      'One to all LLMs and bots answer the same question. With REVIEW, the question and every answer go to the reviewers you pick, who review adversarially and grade each one; the best graded answer, or one a reviewer writes from all of them, is the ground truth.',
    ),
  }),
  Object.freeze({
    id: 3,
    title: msgl(
      '3. One Question at a time- Self-Correction, Multiple Answers/ same teachers-adversarial review',
    ),
    note: msgl(
      'The teacher answers, then gets the question back with its response id and response, asked to review it adversarially and work harder to find the ground truth. Its second answer is the ground truth.',
    ),
  }),
  Object.freeze({
    id: 4,
    title: msgl(
      '4. One Question at a time- 2X Self-Correction Multiple Answers/same teachers-adversarial review',
    ),
    note: msgl(
      'As 3, then the second response id goes back to the same teacher for more refinement and adversarial review. Its third answer is the ground truth.',
    ),
  }),
  Object.freeze({
    id: 5,
    title: msgl(
      '5. One Question at a time- Multi-Turn Reflection with differing Teachers Multiple Answers-adversarial review',
    ),
    note: msgl(
      'One teacher answers; a different teacher gets the question with that response id and response, asked to review it adversarially and work harder to find the ground truth. Its answer is the ground truth.',
    ),
  }),
  Object.freeze({
    id: 6,
    title: msgl(
      '6. One Question at a time- Multi-Turn Reflection with differing Teachers + Self-Correction Multiple Answers-adversarial review',
    ),
    note: msgl(
      'As 5, then the second response id goes back to the same teacher for more refinement and adversarial review. Its answer is the ground truth.',
    ),
  }),
  Object.freeze({
    id: 7,
    title: msgl(
      '7. One Question at a time- Self-Correction + Multi-Turn Reflection with differing Teachers Multiple Answers-adversarial review',
    ),
    note: msgl(
      'The teacher answers and corrects itself as in 3; then the second response id goes to a different teacher for more refinement and adversarial review. Its answer is the ground truth.',
    ),
  }),
]);

/** Ground truth in heading 2 with REVIEW: the best graded answer, or one a reviewer writes. */
export const DISTILL_PICKS = Object.freeze(['best-graded', 'writer']);
/** Heading 6's third turn: back to turn 2's teacher (the default) or turn 1's. */
export const DISTILL_TURN3_FROM = Object.freeze(['turn2', 'turn1']);
export const DISTILL_QUESTION_MAX = 8000;
export const DISTILL_QUESTIONS_MAX = 10_000;
export const DISTILL_NAME_MAX = 80;
export const DISTILL_PROMPT_MAX = 6000;

/** What each prompt says unless the sub-heading changes it. {placeholders} are filled per question. */
export const DISTILL_DEFAULT_PROMPTS = Object.freeze({
  system:
    'You are a careful expert teacher. Answer the question accurately and completely. Reason step by step where it helps, then give the answer. Say plainly what is uncertain; never invent facts, sources, quotes or numbers.',
  review:
    'ORIGINAL QUESTION:\n{question}\n\nRESPONSE ID: {responseId}\nRESPONSE (from {teacher}):\n{response}\n\nReview this response adversarially: look for every error, gap, unsupported claim, wrong number and weak step, and check it against what you know. Work harder than the response did to find the ground truth answer. Write your review, then the corrected, complete answer after a line that reads exactly:\nGROUND TRUTH ANSWER:',
  grade:
    'QUESTION:\n{question}\n\nANSWERS:\n{answers}\n\nReview every answer adversarially: find each error, gap and unsupported claim, and establish the ground truth yourself. Grade each answer from 0 to 10 for correctness and completeness. Reply with JSON only, in this shape:\n{"grades": [{"id": "R1", "score": 7, "critique": "what is wrong or missing"}], "best": "R1"}',
  write:
    'QUESTION:\n{question}\n\nANSWERS:\n{answers}\n\nADVERSARIAL REVIEWS:\n{reviews}\n\nUsing the answers and the reviews, write the single best ground truth answer: correct, complete and free of every error the reviews found. Write it after a line that reads exactly:\nGROUND TRUTH ANSWER:',
});
const GROUND_TRUTH_MARK = /GROUND TRUTH ANSWER:\s*/i;

/**
 * The turns of a heading, from a sub-heading's teachers. Each turn names its
 * teacher, its role, and which earlier turn it reviews.
 *
 *   1  answer(t1)
 *   2  answer(each of `teachers`), then grade(each of `reviewers`), then write(writer)
 *   3  answer(t1), review(t1 of turn 1)
 *   4  answer(t1), review(t1 of 1), review(t1 of 2)
 *   5  answer(t1), review(t2 of 1)                    t2 differs from t1
 *   6  answer(t1), review(t2 of 1), review(t3 of 2)   t3 = t2 (default) or t1
 *   7  answer(t1), review(t1 of 1), review(t2 of 2)   t2 differs from t1
 *
 * @returns {{ok: true, turns: Array<{turn: number, role: string, teacher: string, of?: number, same?: boolean}>} | {ok: false, error: string}}
 */
export function planTurns(heading, config = {}) {
  const t1 = String(config.t1 || '');
  const t2 = String(config.t2 || '');
  const need = (id, what) =>
    id ? null : { ok: false, error: `Choose ${what}.` };
  const h = Number(heading);
  switch (h) {
    case 1:
      return (
        need(t1, 'a teacher') || {
          ok: true,
          turns: [{ turn: 1, role: 'answer', teacher: t1 }],
        }
      );
    case 2: {
      const teachers = unique(config.teachers);
      if (!teachers.length)
        return { ok: false, error: 'Choose one or more teachers to answer.' };
      const turns = teachers.map((teacher, i) => ({
        turn: 1,
        role: 'answer',
        teacher,
        answer: i + 1,
      }));
      if (config.review) {
        const reviewers = unique(config.reviewers);
        if (!reviewers.length)
          return { ok: false, error: 'Choose one or more reviewers.' };
        for (const teacher of reviewers)
          turns.push({ turn: 2, role: 'grade', teacher });
        if (config.pick === 'writer') {
          const writer = String(config.writer || '');
          if (!writer)
            return {
              ok: false,
              error: 'Choose the reviewer who writes the ground truth.',
            };
          turns.push({ turn: 3, role: 'write', teacher: writer });
        }
      }
      return { ok: true, turns };
    }
    case 3:
      return (
        need(t1, 'a teacher') || {
          ok: true,
          turns: [
            { turn: 1, role: 'answer', teacher: t1 },
            { turn: 2, role: 'review', teacher: t1, of: 1, same: true },
          ],
        }
      );
    case 4:
      return (
        need(t1, 'a teacher') || {
          ok: true,
          turns: [
            { turn: 1, role: 'answer', teacher: t1 },
            { turn: 2, role: 'review', teacher: t1, of: 1, same: true },
            { turn: 3, role: 'review', teacher: t1, of: 2, same: true },
          ],
        }
      );
    case 5:
    case 6:
    case 7: {
      const missing =
        need(t1, 'the first teacher') || need(t2, 'the second teacher');
      if (missing) return missing;
      if (t1 === t2)
        return {
          ok: false,
          error: 'The second teacher must differ from the first.',
        };
      if (h === 5)
        return {
          ok: true,
          turns: [
            { turn: 1, role: 'answer', teacher: t1 },
            { turn: 2, role: 'review', teacher: t2, of: 1, same: false },
          ],
        };
      if (h === 6) {
        const third = config.turn3From === 'turn1' ? t1 : t2;
        return {
          ok: true,
          turns: [
            { turn: 1, role: 'answer', teacher: t1 },
            { turn: 2, role: 'review', teacher: t2, of: 1, same: false },
            {
              turn: 3,
              role: 'review',
              teacher: third,
              of: 2,
              same: third === t2,
            },
          ],
        };
      }
      return {
        ok: true,
        turns: [
          { turn: 1, role: 'answer', teacher: t1 },
          { turn: 2, role: 'review', teacher: t1, of: 1, same: true },
          { turn: 3, role: 'review', teacher: t2, of: 2, same: false },
        ],
      };
    }
    default:
      return { ok: false, error: 'Unknown heading.' };
  }
}

function unique(list) {
  return [
    ...new Set((Array.isArray(list) ? list : []).map(String).filter(Boolean)),
  ];
}

/** Paid calls a question costs under these turns (the manual ones count too). */
export function callsPerQuestion(turns) {
  return Array.isArray(turns) ? turns.length : 0;
}

/** A run's estimate: questions left, calls each, and the teachers that wait for a paste. */
export function estimateRun({ turns, questionsLeft, manual = [] }) {
  const each = callsPerQuestion(turns);
  const waits = turns.filter((t) => manual.includes(t.teacher)).length;
  return {
    questions: questionsLeft,
    callsPerQuestion: each,
    calls: each * questionsLeft,
    pastesPerQuestion: waits,
    pastes: waits * questionsLeft,
  };
}

/** {placeholders} filled; unknown ones are left as they are. */
export function fillPrompt(template, values) {
  return String(template ?? '').replace(/\{([A-Za-z]+)\}/g, (whole, key) =>
    Object.hasOwn(values, key) ? String(values[key] ?? '') : whole,
  );
}

/** The answers block reviewers read: R1 (response id …, teacher):\n… */
export function answersBlock(answers) {
  return answers
    .map(
      (a) =>
        `${a.label} (RESPONSE ID ${a.responseId}, from ${a.teacher}):\n${a.text}`,
    )
    .join('\n\n');
}

/** The reviews block a writer reads. */
export function reviewsBlock(reviews) {
  return reviews
    .map((r) => {
      const lines = Object.entries(r.scores || {}).map(
        ([id, score]) =>
          `${id}: ${score}/10${r.critiques?.[id] ? ` · ${r.critiques[id]}` : ''}`,
      );
      return `${r.teacher}${r.best ? ` (best: ${r.best})` : ''}:\n${lines.join('\n')}`;
    })
    .join('\n\n');
}

/** The answer after "GROUND TRUTH ANSWER:", or the whole text when there is none. */
export function groundTruthOf(text) {
  const value = String(text ?? '');
  const match = GROUND_TRUTH_MARK.exec(value);
  const after = match ? value.slice(match.index + match[0].length).trim() : '';
  return after || value.trim();
}

/**
 * A reviewer's grades from its reply: the JSON it was asked for, else lines
 * like "R2: 8/10". Scores outside 0-10 are clamped; ids not given are dropped.
 * @returns {{scores: Record<string, number>, critiques: Record<string, string>, best: string|null}}
 */
export function readGrades(text, ids) {
  const known = new Set(ids);
  const scores = {};
  const critiques = {};
  let best = null;
  const raw = String(text ?? '');
  for (const candidate of jsonObjects(raw)) {
    const grades = Array.isArray(candidate?.grades) ? candidate.grades : null;
    if (!grades) continue;
    for (const g of grades) {
      const id = String(g?.id ?? '')
        .trim()
        .toUpperCase();
      const score = Number(g?.score);
      if (!known.has(id) || !Number.isFinite(score)) continue;
      scores[id] = Math.max(0, Math.min(10, score));
      if (g?.critique) critiques[id] = String(g.critique).slice(0, 2000);
    }
    const said = String(candidate?.best ?? '')
      .trim()
      .toUpperCase();
    if (known.has(said)) best = said;
    if (Object.keys(scores).length) break;
  }
  if (!Object.keys(scores).length)
    for (const match of raw.matchAll(
      /\b(R\d{1,3})\b[^\n\d]{0,20}?(\d{1,2}(?:\.\d+)?)\s*(?:\/\s*10|out of 10)/gi,
    )) {
      const id = match[1].toUpperCase();
      if (known.has(id) && !(id in scores))
        scores[id] = Math.max(0, Math.min(10, Number(match[2])));
    }
  return { scores, critiques, best };
}

/** Every top-level {...} in a text that parses as JSON. */
function jsonObjects(text) {
  const out = [];
  for (
    let start = text.indexOf('{');
    start >= 0;
    start = text.indexOf('{', start + 1)
  ) {
    let depth = 0;
    let quoted = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '\\') i += 1;
        else if (ch === '"') quoted = false;
      } else if (ch === '"') quoted = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}' && --depth === 0) {
        try {
          out.push(JSON.parse(text.slice(start, i + 1)));
          start = i;
        } catch {
          /* not JSON: try the next brace */
        }
        break;
      }
    }
  }
  return out;
}

/**
 * The best graded answer: the highest mean score over the reviewers who
 * graded it; ties go to the earlier answer. Null when nobody graded.
 */
export function bestGraded(labels, reviews) {
  let best = null;
  for (const label of labels) {
    const got = reviews
      .map((r) => r.scores?.[label])
      .filter((v) => Number.isFinite(v));
    if (!got.length) continue;
    const mean = got.reduce((a, b) => a + b, 0) / got.length;
    if (!best || mean > best.mean) best = { label, mean, votes: got.length };
  }
  return best;
}

/**
 * Questions from a CSV file: the `question` (or `prompt`) column when the
 * header names one, else the first column. Quoted fields, doubled quotes and
 * newlines in quotes are read; blank questions are skipped.
 */
export function questionsFromCsv(text) {
  const rows = parseCsv(String(text ?? '').replace(/^﻿/, ''));
  if (!rows.length) return [];
  const header = rows[0].map((c) => c.trim().toLowerCase());
  let column = header.findIndex((c) => c === 'question' || c === 'questions');
  if (column < 0)
    column = header.findIndex((c) => c === 'prompt' || c === 'input');
  const body = column >= 0 ? rows.slice(1) : rows;
  const at = column >= 0 ? column : 0;
  return body.map((r) => String(r[at] ?? '').trim()).filter(Boolean);
}

/** RFC 4180 rows. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Questions typed in the box: one a line (a blank line between keeps a long one whole). */
export function questionsFromText(text) {
  const value = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!value) return [];
  const blocks = value
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  // One block of several lines: each line is a question. Several blocks: each block is one.
  return blocks.length > 1
    ? blocks
    : value
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
}

/** One CSV field, quoted when it must be. */
export function csvField(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
