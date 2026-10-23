# AI Distillation

The left-hand tab under the Artificial Intelligence World Training Sim where
the owner puts questions to other models and keeps their best answer as the
ground truth to train on (owner request, 2026-10-19: "Create New "AI
Distillation" Tab on dashboard left hand side … use all LLM's and Grok bot
and OpenAI dots … add ability to create unlimited heading features within
each (7)heading"; then "use all the fall back options for grokbot and open AI
dots"). The datasets feed CUSTOM LLM TRAINING in the AI World tab
([TRAINING-GUIDE.md](TRAINING-GUIDE.md), section 4).

## What the tab holds

1. **Status**: one line, what the tab is doing.
2. **INSTRUCTIONS**: the short steps, folded; this file is the full guide.
3. **TEACHERS AND STUDENTS**: every model that can answer, as a teacher or
   as a student, with a swatch for its state: READY (green), PASTE (yellow:
   every route left needs the owner to paste the reply back) or NOT SET UP
   (grey). Each row names the route it uses now and, after THEN, the ones it
   falls back to. An app route reads `APP · THE REPLY COMES BACK BY ITSELF`
   where this PC can bring the reply back (see
   [Replies from the apps](#replies-from-the-apps)).
4. **The run**: `RUN · <state> · QUESTION n/total · n CALLS`, then who is
   answering (`TURN 2 · NVIDIA NIM`, `STUDENT 1 · GROK BOT`) and, over the
   failed questions, `RETRY 1/3`; with PAUSE / CONTINUE (one button) and
   STOP; while an app answers it adds `GROK BOT IS ANSWERING: ITS REPLY
COMES BACK BY ITSELF` (or CHATGPT). A refusal, or a note such as `PROMPT
COPIED`, takes the line for fifteen seconds, then the run is back. The last
   errors are listed under it (`QUESTION n: <error>`).
5. **The paste-back box**: shown only while a fallback waits for the owner
   (see [Paste-back](#paste-back)).
6. **The seven headings**, each folded. Inside each: ADD HEADING with a name
   box, then the owner's own sub-headings, as many as wanted.

Each sub-heading is a saved run of its own:

- **NAME** and RENAME.
- **Questions**: one a line (a blank line between keeps a long one whole),
  ADD QUESTIONS; or LOAD CSV (the column headed `question`, `questions`,
  `prompt` or `input`, or else the first column of every row); CLEAR
  QUESTIONS. A question is kept once: one typed again is refused (`That
question is there already.`).
- **STUDENTS (NONE TO ALL)**, ticked from the same list as the teachers:
  they answer each question first, and the teachers grade their answers, fix
  the errors and upgrade them (see [Students](#students)).
- **The teachers its heading asks for** (see the table below).
- **Web search**: GROK BOT and OPENAI DOTS search the web while they answer
  (on by default).
- **PROMPTS**, folded: the teacher instructions and the prompts that carry
  the grading and upgrading of the students' answers, the review, the
  grading and the writing (see [Prompts](#prompts)).
- **SAVE SETTINGS**.
- **RUN**: FROM WHERE IT STOPPED, START OVER FROM THE FIRST QUESTION, or
  RETRY THE FAILED QUESTIONS (offered once a question has failed, with the
  count); and **ONE QUESTION, THEN PAUSE**, to try the prompts on one
  question before paying for the rest.
- **ESTIMATE**, then **CONFIRM START**: the paid calls the run will make and
  the replies it will wait for, before it starts, with the plan of each
  question under it (`EACH QUESTION: STUDENT 1 GROK BOT, TURN 1 NVIDIA NIM
GRADES THE STUDENTS AND UPGRADES, TURN 2 NVIDIA NIM REVIEWS`). Both use the
  saved settings: with edits not yet saved the line reads `SAVE SETTINGS
FIRST`. An estimate holds for what it was made for: another RUN choice,
  settings saved, questions added or a question failed since clears it and
  CONFIRM START waits for ESTIMATE again; a start whose count of calls no
  longer matches is refused (`The estimate changed: press ESTIMATE again.`).
- **EXPORT JSONL**, **EXPORT CSV**, the number of ground truths, and the
  line `CLASS RESTRICTED: THE TEACHERS’ TERMS MAY LIMIT TRAINING ON THEIR
ANSWERS`.
- **STUDENT REPORT**: each student's mean grade over the dataset so far
  (`TRAINED HERE · MINE: 6.4/10 OVER 12 GRADED ANSWERS`), and **LAST GROUND
TRUTH**, folded: the last record's question, its ground truth and the
  students' grades, so a run can be judged without an export. Folded, it
  carries the heads the status sends (300 and 600 characters, on one line);
  opened, it fetches the whole record once, with its line breaks. `DID NOT
ANSWER: GROK BOT` names a student, teacher or reviewer whose every route
  failed while the question still went through. **OLDER** and **NEWER** look
  back through the records one at a time (`GROUND TRUTH 4 OF 12 · QUESTION
4`); **DROP THIS RECORD** (PC only, a second press within six seconds) takes
  that question's records out of the dataset and lists the question as
  failed, so RETRY THE FAILED QUESTIONS does it again.
- The sub-heading's own line counts its questions, how many are done (ground
  truths written, not how far the run got), how many failed, and its ground
  truths.
- **CLEAR DATASET** and **DELETE HEADING**: each asks for a second press
  within six seconds.

## The seven headings

Every heading is one question at a time. `t1` is the first teacher, `t2` the
second.

| Heading                                                            | Turns for each question                                                                                                                                                                                                                                                                                                | The ground truth                                                                                                                                                                                   |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. One Answer / one teacher                                        | t1 answers                                                                                                                                                                                                                                                                                                             | t1's answer                                                                                                                                                                                        |
| 2. Multiple Graded Answers / multiple teachers, adversarial review | each ticked teacher answers (three at a time); with REVIEW ticked, each ticked reviewer gets the question and every answer (R1, R2 … with its response id and teacher), reviews them adversarially and grades each 0-10; with GROUND TRUTH = WRITER, the writer gets the answers and the reviews and writes one answer | REVIEW off: every answer is kept as its own record. THE BEST GRADED ANSWER: the highest mean grade (a tie goes to the earlier answer). ONE A REVIEWER WRITES FROM ALL OF THEM: the writer's answer |
| 3. Self-Correction / same teacher                                  | t1 answers; t1 gets the question with its response id and response, asked to review it adversarially and work harder to find the ground truth                                                                                                                                                                          | turn 2                                                                                                                                                                                             |
| 4. 2X Self-Correction / same teacher                               | as 3, then turn 2's response id goes back to t1 again                                                                                                                                                                                                                                                                  | turn 3                                                                                                                                                                                             |
| 5. Multi-Turn Reflection with differing teachers                   | t1 answers; t2 (a different teacher) reviews it                                                                                                                                                                                                                                                                        | turn 2                                                                                                                                                                                             |
| 6. Differing teachers + Self-Correction                            | as 5, then turn 2's response id goes back to t2 (BACK TO TURN 2'S TEACHER, the default) or to t1 (BACK TO TURN 1'S TEACHER)                                                                                                                                                                                            | turn 3                                                                                                                                                                                             |
| 7. Self-Correction + differing teachers                            | t1 answers, t1 reviews itself, then t2 (different) reviews turn 2                                                                                                                                                                                                                                                      | turn 3                                                                                                                                                                                             |

A review turn ends with a line that reads `GROUND TRUTH ANSWER:`; the ground
truth is what follows the last such line (a review of an earlier review may
quote that review's line; Markdown bold around it is read too), or the whole
reply when a teacher leaves the line out. Headings 5, 6 and 7 refuse to
start when t2 is t1.

A teacher's own turns stay in one conversation as far as its route allows:
`previous_response_id` on a key's Responses API (GROK BOT, OPENAI DOTS), the
earlier turns as messages for a chat model, the same chat on the Grok Bot
computer. Every review prompt still carries the question, the response id
and the response, so any teacher can read it cold. A reply with no id of its
own (chat models, pasted replies, the local models) gets `gev-` and twelve
hex digits of its text's SHA-1.

## Students

Any sub-heading may pick students too (owner request 2026-10-21: "Add
ability to choose students … students answer original question. Teachers
grade student answer and upgrade response from student and fix any
errors"). They come from the same list as the teachers; the custom LLMs
trained here are the natural students, so a model's own answers come back
graded and corrected for its next training.

- With students ticked, each question starts with turn 0: every student
  answers the original question, three at a time, as S1, S2 … with its
  response id (STUDENT n in the paste box when its route needs a paste).
- The heading's first teacher turn becomes an **upgrade** instead of a cold
  answer. The teacher gets the question and every student answer, grades
  each one from 0 to 10 with what is wrong or missing (`S1: 7/10 …`), then
  fixes every error and writes the upgraded answer after `GROUND TRUTH
ANSWER:`. In heading 1 that upgraded answer is the ground truth
  (`pickedBy: 'upgrade'`); in heading 2 every ticked teacher upgrades and the
  reviewers grade the upgraded answers; in headings 3-7 the review turns go
  on from the upgrade, on the same teacher's conversation.
- The record keeps the students' answers as turns (`role: 'student'`,
  `turn: 0`, `id: 'S1'`) and each upgrading teacher's grades in
  `studentGrades` (`scores`, `critiques`); EXPORT CSV adds the `students`
  and `student_grades` columns.
- A student that fails (every route failed, or its paste was skipped) is
  left out and named in the record's `failures` (the LAST GROUND TRUTH box
  reads `DID NOT ANSWER: …`); when no student answers, the question fails.
  ESTIMATE counts the students' answers among the calls (`n STUDENT ANSWERS
AMONG THEM`).
- The prompt is GRADING AND UPGRADING THE STUDENTS’ ANSWERS in PROMPTS.

## Teachers

| Teacher                                                                                 | How it answers, in order                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The Ask panel's LLMs (NVIDIA NIM, xAI Grok, OpenRouter, Anthropic, the custom endpoint) | its POWER UP key, one `/chat/completions` call through the Ask panel's settings (`buildLlmChatCall`, `server/providers/llm/ask.js`), up to 4,096 answer tokens                                                                                                                                                                                                 |
| GROK BOT                                                                                | 1. its own key (`GROK_BOT_API_KEY`, xAI Responses API, web search); 2. the Grok Bot computer (the swarm's gateway: the prompt goes to the bot and its report comes back; a bot on a swarm task is waited for, up to ten minutes, before the next route); 3. the Chief of Staff webhook (the task is sent; the reply is read back from the Grok Bot window); 4. the Grok Bot app (opened with the prompt pasted in; the reply is read back) |
| OPENAI DOTS                                                                             | 1. its own key (`OPENAI_DOTS_API_KEY`, OpenAI Responses API, web search); 2. the ChatGPT app (opened with the prompt pasted in; the reply comes back through its Copy response button)                                                                                                                                                                         |
| TRAINED HERE · `<name>`                                                                 | a custom LLM from CUSTOM LLM TRAINING (`.gev-data/llm/<name>/model`), asked through `py -3.13 -m ml.gevtape.llm_chat --json` on this PC                                                                                                                                                                                                                        |

A route that fails passes to the next one; the turn records every try
(`tried`). Errors never carry a key. The Grok Bot computer is shared with
the social swarm (`server/shared/grokBotComputer.mjs`), so the two never
hand the same bot two prompts at once. A bot's key goes on with its own
`previous_response_id` on a review turn; when the key gave no id (a `gev-…`
id was made here), the turn starts over with the system prompt instead of
sending an id the API would refuse. The list is read again for every call:
a key added mid-run counts, and a custom LLM deleted mid-run fails its turn
with `… is not on the list any more.`

Models too big for any training on this PC (Meta Muse Spark Open, DeepSeek
V4 Pro and Flash; `docs/TRAINING-GUIDE.md`, part 4) belong here as teachers:
reach them through the Ask panel's OpenRouter or custom-endpoint provider
with its key in POWER UP, and their answers become ground truths a smaller
student trains on.

## Replies from the apps

The apps' routes bring the reply back by themselves where they can (owner,
2026-10-19: "use same method in fallback methods to copy and paste answers
back in GEVC", "still uses DOTs automation follow best effort";
`server/shared/desktopReply.mjs`, `scripts/read-desktop-reply.ps1`). Windows
only; nothing is installed or downloaded: the apps must already be on the PC
and signed in.

1. The prompt goes into the app the way the swarm pastes a task (the app
   opens, comes to the front, Ctrl+V, Enter), into whichever chat is open,
   with a tag such as `[GEV-1a2b3c4d]` on its last line.
2. The reader finds the message carrying that tag through Windows UI
   Automation (both apps are Electron, so their text is readable without a
   click) and waits for the reply after it: no Stop button, and the reply
   unchanged for 5 seconds (ChatGPT, which also shows its Copy response bar
   only when done) or 15 seconds (Grok Bot, whose typing dots are hidden
   from UI Automation). It waits up to 10 minutes.
3. **ChatGPT**: its own **Copy response** button, clicked for real with
   ChatGPT in front (the window restored, kept on top, hovered and the point
   checked first), so the reply comes back as ChatGPT wrote it, Markdown
   included; when the click copies nothing, the reply's text is read
   instead. **Grok Bot** has no copy button on a reply, so its text is read
   (each message without its first line, the sender's name).
4. After the Chief of Staff webhook, the task carries the tag too, and the
   reply is read from the Grok Bot window when it shows there within 3
   minutes; nothing is pasted.

One paste-and-copy at a time on this PC: a paste and a copy take the
foreground, the mouse and the clipboard (the clipboard ends up holding the
reply). A prompt longer than 16,384 characters is not pasted. Whatever
fails (the app is not open, the prompt never shows, no finished reply in
time) leaves the turn to the paste-back box, with the reason.

## Paste-back

When the only route left for a teacher cannot bring its reply back (the
Chief of Staff webhook, the Grok Bot app, the ChatGPT app, on another OS or
when bringing it back failed), the run reads
`RUN · WAITING FOR YOUR PASTE` and the paste-back box shows the teacher, the question and
turn, and the whole prompt:

- **COPY PROMPT**, or **OPEN GROK BOT AND PASTE** / **OPEN CHATGPT AND
  PASTE** (copies the prompt and opens the app with it pasted in). For the
  webhook the task has already gone to the Chief of Staff; paste the reply
  it gets from Grok Bot. When the app already has the prompt (`ALREADY IN
GROK BOT: PASTE ITS REPLY HERE`), paste only its reply.
- Paste the app's reply in the box, then **SUBMIT ANSWER**; the run goes on.
- **SKIP**: no reply; that question is not kept and the run goes on.

Heading 2's teachers answer three at a time, but their pastes are asked for
one at a time, in order. ESTIMATE says how many replies a run will wait for.

## Running

- One run at a time, across every heading.
- **CONFIRM START** begins at the first question not yet done (FROM WHERE IT
  STOPPED); START OVER FROM THE FIRST QUESTION begins at question 1 again
  (the dataset is kept: clear it first for a clean one); RETRY THE FAILED
  QUESTIONS goes over the questions that failed, in order, and takes each
  one that passes off the list (one that fails again stays on it). Nothing
  changes until CONFIRM START, not even START OVER.
- **ONE QUESTION, THEN PAUSE** pauses the run after one question; CONTINUE
  runs the rest.
- **PAUSE** finishes the question it is on, then stops (`PAUSES AFTER THIS
QUESTION`); **CONTINUE** goes on at the next, keeping the run's count of
  calls and its errors, and a retry the questions it still owes. **STOP**
  ends the run at once; the question it was on is not kept.
- A question that fails (every route of a teacher failed, no student
  answered, no reviewer gave a grade to read) is counted as failed, listed
  for RETRY, its error is shown, and the run goes on with the next.
- While a sub-heading's run is going (running or waiting for a paste), its
  questions and settings cannot be changed; pause or stop it first.

## Prompts

PROMPTS holds up to five boxes; an empty box, or the default text, means the
default.

- **TEACHER INSTRUCTIONS**: the system prompt of every call.
- **GRADING AND UPGRADING THE STUDENTS’ ANSWERS** (`{question} {answers}`):
  the first teacher turn when students are ticked; asks for a `S1: 7/10`
  line per student with what is wrong, then the upgraded answer after
  `GROUND TRUTH ANSWER:`. Grades are read from the JSON a reviewer is asked
  for, else from lines such as `S1: 7/10`, `**S1** — 2 errors, 6/10`,
  `Student 1: 7.5 / 10` or `Answer 2: 9 out of 10` (`Student n` is `Sn`;
  `Answer n` and `Response n` are `Rn`; a score belongs to the last id
  before it on its line; `7/100` is not a grade).
- **ADVERSARIAL REVIEW** (`{question} {responseId} {teacher} {response}`):
  headings 3-7's review turns.
- **GRADING** (`{question} {answers}`): heading 2's reviewers; asks for JSON
  `{"grades": [{"id": "R1", "score": 7, "critique": "…"}], "best": "R1"}`.
  Lines such as `R2: 8/10` are read as well.
- **WRITING THE GROUND TRUTH** (`{question} {answers} {reviews}`): heading
  2's writer.

## The data

Everything is under the gitignored `.gev-data/distill/`:

```text
state.json                 the sub-headings: id, heading, name, settings
<id>/questions.json        the questions, in order
<id>/dataset.jsonl         one record per ground truth
<id>/run.json              { cursor, done, failed, failedQuestions, retryQueue }:
                           where the run goes on, the questions that failed
                           (1-based), the ones a retry under way still owes
```

The status reads each dataset as it grows (the file is only ever appended
to): the count, each student's mean grade and the last record come from the
lines added since the last poll, never from the whole file again.

A record:

```js
{
  id: 'h3-1a2b3c4d5e-7',          // sub-heading id, question number (heading 2 adds -R1 … when REVIEW is off)
  heading: 3, feature: 'name', featureId: 'h3-1a2b3c4d5e',
  question: '…',
  groundTruth: '…',
  pickedBy: 'single' | 'final-turn' | 'upgrade' | 'answer' | 'best-graded' | 'writer',
  turns: [{ turn, role: 'student' | 'answer' | 'upgrade' | 'review' | 'grade' | 'write',
            teacher, label, route, model, responseId, text, tried?, at, id? }],  // id: S1 …, R1 …
  studentGrades: [{ teacher, label, scores: { S1: 7 }, critiques }],  // with students
  grades: [{ reviewer, label, scores: { R1: 8 }, critiques, best }, { best, mean, votes }],  // heading 2
  failures: [{ role: 'student', teacher, label, error }],  // who did not answer while the question went through
  class: 'restricted',
  createdAt: 1760000000000,
}
```

- **EXPORT JSONL** downloads `dataset.jsonl` as it is; **EXPORT CSV** gives
  `id, heading, question, ground_truth, picked_by, teachers, students,
student_grades, class`.
- **Training**: in CUSTOM LLM TRAINING tick **DISTILLED ANSWERS (AI
  DISTILLATION)**. Every record of every sub-heading becomes one chat example,
  the question as the user's turn and the ground truth as the assistant's
  (`ml/gevtape/llm_data.py`, source `distilled`).
- **Licence class**: `restricted`. The answers are the providers' model
  outputs, and their terms may limit training on them; the trained model
  records the class, and nothing is published anywhere.

Limits: 10,000 questions a sub-heading, 8,000 characters a question, a 4 MB
CSV file, 80 characters a name, 6,000 characters a prompt.

## The owner's phone

From the tailnet mirror everything works except the removals: CLEAR
QUESTIONS, CLEAR DATASET, DROP THIS RECORD and DELETE HEADING do nothing and
say nothing (`403 pc-only`), as every removal from the phone (owner ruling
2026-10-11).

## Server routes (`/api/distill`)

Admitted as the AI World tab's routes are: this machine's loopback and Host,
an exact Origin on writes, JSON bodies (128 KB; 5 MB for `/questions`).

```text
GET    /status            headings, teachers, sub-headings, the run
POST   /features          { heading, name }        add a sub-heading
POST   /features/update   { id, name?, config? }
DELETE /features          { id }
POST   /questions         { id, text } or { id, csv }
DELETE /questions         { id }
DELETE /dataset           { id }
GET    /records?id=&at=   one record, `at` counted back from the newest (0: the last)
DELETE /records           { id, at }              drop that question's records; it is listed for RETRY
POST   /estimate          { id, fresh?, retry? }   paid calls before START
POST   /start             { id, confirm: true, fresh?, retry?, pauseAfter?, calls? }
                          calls: the count confirmed; refused when the estimate changed
POST   /pause  /continue  /stop
POST   /paste             { answer }               a reply from a manual route
POST   /skip
GET    /export?id=&format=jsonl|csv
```

`config`: `t1`, `t2`, `students`, `teachers`, `reviewers`, `review`, `pick`
(`best-graded` or `writer`), `writer`, `turn3From` (`turn2` or `turn1`),
`webSearch`, `prompts` (`system`, `upgrade`, `review`, `grade`, `write`).

Each sub-heading in `/status` carries, besides its settings: `questions`,
`preview`, `cursor`, `done`, `failed`, `failedQuestions`, `records`,
`students` (`teacher`, `label`, `answers`, `graded`, `mean`) and `last` (the
last record's `question` and `groundTruth` heads, `more` when either was
cut, `pickedBy`, `teachers`, `students`, `failed`, `grades`, `createdAt`);
`GET /records` gives the same view of one record with the texts whole, their
lines kept.
The run carries `now` (who is answering: `teacher`, `label`, `question`,
`turn`, `student` or `answer` or `reviewer`), `retry`, `retryAt`, `retryOf`
and `pauseAfter`.

The code: `src/distillCore.mjs` (the headings' turns, the estimate, reading
grades and CSV), `src/distillPanel.js` (the tab),
`server/shared/distillTeachers.mjs` (the teachers and their routes),
`server/shared/distillJobs.mjs` (the runs and the files),
`server/providers/distill.js` (the routes).
