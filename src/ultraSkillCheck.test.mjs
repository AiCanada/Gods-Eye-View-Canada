import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SKILL_CHECK_APP_OPTIONS,
  SKILL_CHECK_BOTS,
  SKILL_CHECK_RULES,
  SKILL_CHECK_SKILLS_MAX,
  cleanSkillCheckClaim,
  cleanSkillCheckRecord,
  combineSkillVerdicts,
  planSkillCheckBot,
  planSkillCheckHandoff,
  readPastedUltraTokenSkills,
  readSkillCheckAnswer,
  skillCheckBots,
  skillCheckNamedSites,
  skillCheckSwarmChoices,
  skillVerdictWords,
} from './ultraSkillCheck.mjs';
import { readPastedSkillReport, runSkillCheck } from './ultraSkillCheckRun.mjs';

const NOW = new Date('2026-10-12T15:00:00.000Z');
const CLAIM = {
  skills: 'Paramedic, Electrician',
  name: 'Sam Example',
  location: 'Halifax, NS',
  age: '41',
  sex: 'Female',
  profession: 'Paramedic',
  urls: ['example.org/sam', ''],
  apps: 'LinkedIn, GitHub, SomeApp',
};

test('the form: skills and a name or link are needed; every other detail is optional and checked', () => {
  const ok = cleanSkillCheckClaim(CLAIM);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.claim, {
    skills: ['Paramedic', 'Electrician'],
    name: 'Sam Example',
    alias: '',
    location: 'Halifax, NS',
    age: 41,
    sex: 'female',
    profession: 'Paramedic',
    urls: ['https://example.org/sam'],
    apps: ['LinkedIn', 'GitHub', 'SomeApp'],
  });
  assert.equal(
    cleanSkillCheckClaim({ ...CLAIM, alias: 'Sammy' }).claim.alias,
    'Sammy',
  );
  assert.match(
    cleanSkillCheckClaim({ name: 'Sam' }).error,
    /at least one skill/,
  );
  assert.match(
    cleanSkillCheckClaim({ skills: 'Medic' }).error,
    /name or one of their links/,
  );
  assert.equal(
    cleanSkillCheckClaim({ skills: 'Medic', urls: 'https://a.example/me' }).ok,
    true,
    'a link alone finds the person',
  );
  assert.match(
    cleanSkillCheckClaim({ skills: 'Medic', name: 'Sam', age: '7' }).error,
    /Age/,
  );
  assert.match(
    cleanSkillCheckClaim({
      skills: 'Medic',
      name: 'Sam',
      urls: 'javascript:alert(1)',
    }).error,
    /not a web address/,
  );
  assert.match(
    cleanSkillCheckClaim({ skills: 'Medic', name: 'sk-abcdefghijklmnopqrstu' })
      .error,
    /key or token/,
  );
  assert.match(
    cleanSkillCheckClaim({ skills: 'Medic', name: 'Sam uht1.abc' }).error,
    /key or token/,
    'an Ultra Token never goes to a bot',
  );
  const many = Array.from(
    { length: SKILL_CHECK_SKILLS_MAX + 1 },
    (_, i) => `Skill ${i}`,
  );
  assert.match(
    cleanSkillCheckClaim({ skills: many, name: 'Sam' }).error,
    /at most/,
  );
  assert.equal(
    cleanSkillCheckClaim({ skills: many.slice(0, 20), name: 'Sam' }).ok,
    true,
    'every skill one token can carry is checked at once',
  );
  assert.equal(cleanSkillCheckClaim({ ...CLAIM, sex: 'robot' }).claim.sex, '');
});

test('a pasted Ultra Token decrypts to its skills; the token never goes to a bot', () => {
  const secret = `uht1.${'A'.repeat(43)}`;
  assert.equal(readPastedUltraTokenSkills('Paramedic, Electrician'), null);
  assert.deepEqual(readPastedUltraTokenSkills(`${secret}.s.pm`).skills, [
    'Paramedic',
  ]);
  assert.deepEqual(readPastedUltraTokenSkills(`  ${secret}.s.pm.dr  `).skills, [
    'Paramedic',
    'Doctor',
  ]);
  assert.equal(readPastedUltraTokenSkills(secret).skills.length, 0);
  assert.equal(
    readPastedUltraTokenSkills(`${secret}.e.${'B'.repeat(40)}`).encrypted,
    true,
  );
  const opened = cleanSkillCheckClaim({
    skills: `${secret}.s.pm.xplumber`,
    name: 'Sam',
    alias: 'Sammy',
  });
  assert.equal(opened.ok, true);
  assert.deepEqual(opened.claim.skills, ['Paramedic', 'Plumber']);
  assert.equal(opened.claim.alias, 'Sammy');
  assert.match(
    JSON.stringify(opened.claim),
    /^(?!.*uht1).*$/,
    'the token is not in the claim',
  );
  assert.match(
    cleanSkillCheckClaim({ skills: secret, name: 'Sam' }).error,
    /names no skills/,
  );
  assert.match(
    cleanSkillCheckClaim({
      skills: `${secret}.e.${'B'.repeat(40)}`,
      name: 'Sam',
    }).error,
    /encrypted/,
  );
  const task = planSkillCheckBot({
    provider: 'openai',
    bot: 'news',
    claim: { ...CLAIM, alias: 'Sammy' },
    now: NOW,
  }).payload.input[1].content;
  assert.match(task, /Also known as: Sammy/);
});

test('apps to search are the known sites, each selectable by name', () => {
  const labels = SKILL_CHECK_APP_OPTIONS.map((option) => option.label);
  assert.ok(labels.includes('LinkedIn'));
  assert.ok(labels.includes('X'));
  assert.ok(labels.includes('GitHub'));
  assert.ok(labels.includes('Facebook'));
  assert.equal(
    labels.includes('Twitter'),
    false,
    'X is the option; twitter is an alias',
  );
  for (const option of SKILL_CHECK_APP_OPTIONS) {
    const sites = skillCheckNamedSites({ urls: [], apps: [option.label] });
    assert.ok(sites.length, `${option.label} maps to a public site`);
  }
});

test('the bots: LinkedIn, the social platforms, licence registries and the web; their own links and apps join when named', () => {
  assert.deepEqual(
    SKILL_CHECK_BOTS.map((bot) => bot.id),
    [
      'linkedin',
      'x',
      'facebook',
      'instagram',
      'threads',
      'tiktok',
      'registries',
      'news',
    ],
  );
  const claim = cleanSkillCheckClaim(CLAIM).claim;
  const named = skillCheckBots(claim).at(-1);
  assert.equal(named.id, 'named');
  assert.deepEqual(named.domains, [
    'example.org',
    'linkedin.com',
    'github.com',
  ]);
  assert.equal(
    skillCheckBots({ skills: ['Medic'], name: 'Sam', urls: [], apps: [] })
      .length,
    SKILL_CHECK_BOTS.length,
  );
});

test('every bot is told: the skills only, nothing else about the person, age and sex never written, nothing invented', () => {
  assert.match(SKILL_CHECK_RULES, /only public posts and public pages/);
  assert.match(SKILL_CHECK_RULES, /Never sign in/);
  assert.match(SKILL_CHECK_RULES, /Check only the claimed skills/);
  assert.match(SKILL_CHECK_RULES, /home address, phone number, family, photos/);
  assert.match(
    SKILL_CHECK_RULES,
    /age and sex given are only there to tell apart/,
  );
  assert.match(
    SKILL_CHECK_RULES,
    /Finding nothing is NO CONFIRMATION, never REJECTED CLAIM/,
  );
  const plan = planSkillCheckBot({
    provider: 'openai',
    bot: 'named',
    claim: CLAIM,
    model: 'gpt-test',
    now: NOW,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.payload.input[0].content, SKILL_CHECK_RULES);
  const task = plan.payload.input[1].content;
  assert.match(task, /Today is 2026-10-12/);
  assert.match(task, /Age: about 41 \(only to tell people apart\)/);
  assert.match(task, /Their own links: https:\/\/example\.org\/sam/);
  assert.deepEqual(plan.payload.tools, [
    {
      type: 'web_search',
      filters: {
        allowed_domains: ['example.org', 'linkedin.com', 'github.com'],
      },
    },
  ]);
  const x = planSkillCheckBot({
    provider: 'xai',
    bot: 'x',
    claim: CLAIM,
    now: NOW,
  });
  assert.deepEqual(x.payload.tools, [{ type: 'x_search' }]);
  assert.equal(
    planSkillCheckBot({ provider: 'nope', bot: 'x', claim: CLAIM }).ok,
    false,
  );
  const handoff = planSkillCheckHandoff({ claim: CLAIM, now: NOW });
  assert.match(
    handoff.text,
    /^Chief of Staff: run a CONFIRM ULTRA TOKEN SKILLS check/,
  );
  assert.match(handoff.text, /You may give each site to one of your bots/);
  assert.match(handoff.text, /Age: about 41/);
  assert.doesNotMatch(handoff.text, /only to tell people apart/);
  assert.doesNotMatch(handoff.text, /one combined line/);
  assert.doesNotMatch(handoff.text, /Never sign in/);
  assert.match(
    handoff.text,
    /skill · VERDICT · one short reason ; NO CONFIRMATION/,
  );
  assert.match(handoff.text, /Is this token Skill claimed trust worthy\?$/);
  assert.deepEqual(handoff.skills, ['Paramedic', 'Electrician']);
  assert.match(
    planSkillCheckHandoff({ claim: CLAIM, now: NOW, lead: 'ChatGPT' }).text,
    /^ChatGPT: run a CONFIRM ULTRA TOKEN SKILLS check/,
  );
});

test('the swarm select: GROK BOT SWARM, OPENAI DOT SWARM, and LLM from POWER UP', () => {
  assert.deepEqual(
    skillCheckSwarmChoices([]).map((row) => [row.value, row.label]),
    [
      ['xai', 'GROK BOT SWARM'],
      ['openai', 'OPENAI DOT SWARM'],
      ['llm', 'LLM'],
    ],
  );
  assert.deepEqual(
    skillCheckSwarmChoices([
      { id: 'xai', label: 'xAI Grok', ready: true },
      { id: 'anthropic', label: 'Anthropic Claude', ready: false },
    ]).map((row) => [row.value, row.label]),
    [
      ['xai', 'GROK BOT SWARM'],
      ['openai', 'OPENAI DOT SWARM'],
      ['llm', 'LLM · xAI Grok'],
    ],
  );
  assert.deepEqual(
    skillCheckSwarmChoices([
      { id: 'xai', label: 'xAI Grok', ready: true },
      { id: 'nvidia', label: 'NVIDIA NIM', ready: true },
    ]).map((row) => [row.value, row.label]),
    [
      ['xai', 'GROK BOT SWARM'],
      ['openai', 'OPENAI DOT SWARM'],
      ['llm', 'LLM · ALL'],
      ['llm:xai', 'LLM · xAI Grok'],
      ['llm:nvidia', 'LLM · NVIDIA NIM'],
    ],
  );
});

test('reading an answer: one verdict per skill, a link behind every CONFIRMED or REJECTED CLAIM', () => {
  const skills = ['Paramedic', 'Electrician', 'Pilot', 'Diver'];
  const text = [
    '**Paramedic** · CONFIRMED · listed on the provincial paramedic register · https://register.example/ns/123.',
    '- Electrician: REJECTED CLAIM — licence lapsed in 2024 https://trades.example/lic/9',
    'Pilot · CONFIRMED · says so on a forum',
    'Something else · CONFIRMED · https://elsewhere.example',
  ].join('\n');
  assert.deepEqual(readSkillCheckAnswer(text, skills), [
    {
      skill: 'Paramedic',
      verdict: 'confirmed',
      reason: 'listed on the provincial paramedic register',
      links: ['https://register.example/ns/123'],
    },
    {
      skill: 'Electrician',
      verdict: 'rejected',
      reason: 'licence lapsed in 2024',
      links: ['https://trades.example/lic/9'],
    },
    {
      skill: 'Pilot',
      verdict: 'none',
      reason: 'says so on a forum',
      links: [],
    },
    { skill: 'Diver', verdict: 'none', reason: '', links: [] },
  ]);
  assert.equal(
    readSkillCheckAnswer('Paramedic · NOT CONFIRMED · nothing', [
      'Paramedic',
    ])[0].verdict,
    'none',
  );
});

test('folding the bots: a rejection with its link wins, then a confirmation, else NO CONFIRMATION', () => {
  const skills = ['Paramedic', 'Electrician', 'Pilot'];
  const yes = (skill, reason, link) => ({
    skill,
    verdict: 'confirmed',
    reason,
    links: [link],
  });
  const none = (skill) => ({ skill, verdict: 'none', reason: '', links: [] });
  const verdicts = combineSkillVerdicts(skills, [
    {
      bot: 'LinkedIn',
      verdicts: [
        yes('Paramedic', 'profile', 'https://linkedin.com/in/sam'),
        yes('Electrician', 'profile', 'https://linkedin.com/in/sam'),
        none('Pilot'),
      ],
    },
    {
      bot: 'Licence registries',
      verdicts: [
        yes('Paramedic', 'register', 'https://register.example/1'),
        {
          skill: 'Electrician',
          verdict: 'rejected',
          reason: 'lapsed',
          links: ['https://trades.example/9'],
        },
        none('Pilot'),
      ],
    },
  ]);
  assert.deepEqual(
    verdicts.map((row) => [row.skill, row.verdict, row.mixed === true]),
    [
      ['Paramedic', 'confirmed', false],
      ['Electrician', 'rejected', true],
      ['Pilot', 'none', false],
    ],
  );
  assert.deepEqual(verdicts[0].links, [
    'https://linkedin.com/in/sam',
    'https://register.example/1',
  ]);
  assert.deepEqual(verdicts[0].bots, ['LinkedIn', 'Licence registries']);
  assert.deepEqual(verdicts[1].bots, ['Licence registries']);
  assert.equal(verdicts[2].reason, 'Nothing public found either way.');
  assert.equal(
    skillVerdictWords(verdicts[1]),
    'ELECTRICIAN: REJECTED CLAIM (MIXED)',
  );
  assert.equal(skillVerdictWords(verdicts[2]), 'PILOT: NO CONFIRMATION');
});

test('the saved record: verdicts and links only; a verdict without a link is not one; junk is dropped', () => {
  assert.equal(cleanSkillCheckRecord(null), null);
  assert.equal(
    cleanSkillCheckRecord({ at: 1, via: 'xai', verdicts: [] }),
    null,
  );
  assert.equal(
    cleanSkillCheckRecord({
      at: 1,
      via: 'mystery',
      verdicts: [{ skill: 'A' }],
    }),
    null,
  );
  const record = cleanSkillCheckRecord({
    at: 1760280000000.7,
    via: 'openai',
    name: 'Sam Example',
    age: 41,
    verdicts: [
      {
        skill: 'Paramedic',
        verdict: 'confirmed',
        reason: 'register',
        links: ['https://register.example/1', 'javascript:x'],
        bots: ['LinkedIn'],
      },
      {
        skill: 'Electrician',
        verdict: 'rejected',
        reason: 'no link',
        links: [],
      },
      { skill: 'Paramedic', verdict: 'none' },
      { skill: 'Pilot', verdict: 'weird' },
    ],
  });
  assert.equal(
    cleanSkillCheckRecord({
      at: 1,
      via: 'llm',
      verdicts: [{ skill: 'A', verdict: 'none' }],
    }).via,
    'llm',
  );
  assert.deepEqual(record, {
    at: 1760280000000,
    via: 'openai',
    verdicts: [
      {
        skill: 'Paramedic',
        verdict: 'confirmed',
        reason: 'register',
        links: ['https://register.example/1'],
        bots: ['LinkedIn'],
      },
      {
        skill: 'Electrician',
        verdict: 'none',
        reason: 'no link',
        links: [],
        bots: [],
      },
      { skill: 'Pilot', verdict: 'none', reason: '', links: [], bots: [] },
    ],
  });
});

function answering(routes) {
  const sent = [];
  const request = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    sent.push({ url, body });
    const reply = routes(url, body);
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => reply.json,
    };
  };
  return { request, sent };
}

test('the run: every bot on the swarm key, answers folded per skill; failures are counted, not guessed', async () => {
  const { request, sent } = answering((url, body) => {
    if (url === '/api/social/swarm/skill-check') {
      if (body.bot === 'tiktok')
        return { status: 504, json: { error: 'slow' } };
      const text =
        body.bot === 'registries'
          ? 'Paramedic · CONFIRMED · register · https://register.example/1\nElectrician · REJECTED CLAIM · lapsed · https://trades.example/9'
          : 'Paramedic · NO CONFIRMATION · nothing';
      return { status: 200, json: { ok: true, text } };
    }
    throw new Error(url);
  });
  const result = await runSkillCheck({
    request,
    provider: 'openai',
    claim: CLAIM,
    openaiStatus: { key: true },
  });
  assert.equal(result.ok, true);
  assert.equal(result.via, 'openai');
  assert.equal(result.total, SKILL_CHECK_BOTS.length + 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(
    result.verdicts.map((row) => [row.skill, row.verdict]),
    [
      ['Paramedic', 'confirmed'],
      ['Electrician', 'rejected'],
    ],
  );
  assert.ok(sent.every((row) => row.body.provider === 'openai'));
  assert.deepEqual(sent[0].body.claim.skills, ['Paramedic', 'Electrician']);
});

test('the run: no Grok key and no computer copies the Chief of Staff task and pastes it; a pasted report reads the same way', async () => {
  const copied = [];
  const opens = [];
  const { request } = answering((url, body) => {
    if (url === '/api/social/grok-bot/open') {
      opens.push(body);
      return { status: 200, json: { ok: true, pasted: true } };
    }
    throw new Error(url);
  });
  const result = await runSkillCheck({
    request,
    provider: 'xai',
    claim: CLAIM,
    xaiStatus: { key: false, computer: false },
    copyText: (text) => copied.push(text),
  });
  assert.equal(result.via, 'desktop');
  assert.equal(result.opened, true);
  assert.equal(result.copied, true);
  assert.equal(result.pasted, true);
  assert.equal(opens[0].paste, true);
  assert.match(opens[0].text, /CONFIRM ULTRA TOKEN SKILLS/);
  assert.match(copied[0], /CONFIRM ULTRA TOKEN SKILLS/);
  const { verdicts } = readPastedSkillReport(
    'Paramedic · REJECTED CLAIM · suspended · https://register.example/1',
    result.skills,
  );
  assert.deepEqual(
    verdicts.map((row) => [row.skill, row.verdict, row.bots]),
    [
      ['Paramedic', 'rejected', ['Chief of Staff']],
      ['Electrician', 'none', []],
    ],
  );
});

test('the run: no OPENAI DOTS key copies the ChatGPT task and pastes it', async () => {
  const copied = [];
  const opens = [];
  const { request } = answering((url, body) => {
    if (url === '/api/social/openai-dots/open') {
      opens.push(body);
      return { status: 200, json: { ok: true, pasted: true } };
    }
    throw new Error(url);
  });
  const result = await runSkillCheck({
    request,
    provider: 'openai',
    claim: CLAIM,
    openaiStatus: { key: false },
    copyText: (text) => copied.push(text),
  });
  assert.equal(result.via, 'desktop');
  assert.equal(result.desktopApp, 'chatgpt');
  assert.equal(result.opened, true);
  assert.equal(result.copied, true);
  assert.equal(result.pasted, true);
  assert.equal(opens[0].paste, true);
  assert.match(opens[0].text, /ChatGPT: run a CONFIRM ULTRA TOKEN SKILLS check/);
  assert.match(copied[0], /CONFIRM ULTRA TOKEN SKILLS/);
});

test('the run: LLM asks every ready POWER UP model and folds their verdicts', async () => {
  const { request, sent } = answering((url, body) => {
    if (url === '/api/llm/providers') {
      return {
        status: 200,
        json: {
          providers: [
            { id: 'xai', label: 'xAI Grok', ready: true },
            { id: 'nvidia', label: 'NVIDIA NIM', ready: true },
            { id: 'anthropic', label: 'Anthropic Claude', ready: false },
          ],
        },
      };
    }
    if (url === '/api/llm/ask') {
      const text =
        body.provider === 'xai'
          ? 'Paramedic · CONFIRMED · register · https://register.example/1\nElectrician · NO CONFIRMATION · nothing'
          : 'Paramedic · NO CONFIRMATION · nothing\nElectrician · REJECTED CLAIM · lapsed · https://trades.example/9';
      return { status: 200, json: { answer: text } };
    }
    throw new Error(url);
  });
  const result = await runSkillCheck({
    request,
    provider: 'llm',
    claim: CLAIM,
  });
  assert.equal(result.ok, true);
  assert.equal(result.via, 'llm');
  assert.equal(result.total, 2);
  assert.deepEqual(
    result.verdicts.map((row) => [row.skill, row.verdict]),
    [
      ['Paramedic', 'confirmed'],
      ['Electrician', 'rejected'],
    ],
  );
  const asks = sent.filter((row) => row.url === '/api/llm/ask');
  assert.equal(asks.length, 2);
  assert.match(
    asks[0].body.question,
    /Is this token Skill claimed trust worthy\?/,
  );
  assert.equal(asks[0].body.context.skillCheck.name, 'Sam Example');
  assert.doesNotMatch(JSON.stringify(asks), /uht1/);
  const one = await runSkillCheck({
    request,
    provider: 'llm:nvidia',
    claim: CLAIM,
  });
  assert.equal(one.ok, true);
  assert.equal(one.total, 1);
  assert.equal(one.verdicts[1].verdict, 'rejected');
});

test('the run: LLM with no ready key says add one in POWER UP', async () => {
  const { request, sent } = answering((url) => {
    if (url === '/api/llm/providers') {
      return {
        status: 200,
        json: {
          providers: [{ id: 'xai', label: 'xAI Grok', ready: false }],
        },
      };
    }
    throw new Error(url);
  });
  const result = await runSkillCheck({
    request,
    provider: 'llm',
    claim: CLAIM,
  });
  assert.equal(result.ok, false);
  assert.equal(result.unconfigured, 'No model key yet. Add one in POWER UP.');
  assert.equal(
    sent.some((row) => row.url === '/api/llm/ask'),
    false,
  );
});

test('the run: a refused form never reaches the server, and no answers means nothing to save', async () => {
  const { request, sent } = answering(() => ({
    status: 504,
    json: { error: 'slow' },
  }));
  const refused = await runSkillCheck({
    request,
    provider: 'openai',
    claim: { skills: '' },
  });
  assert.equal(refused.ok, false);
  assert.equal(sent.length, 0);
  const silent = await runSkillCheck({
    request,
    provider: 'openai',
    claim: CLAIM,
    openaiStatus: { key: true },
  });
  assert.equal(silent.ok, false);
  assert.match(silent.error, /Nothing was saved/);
  assert.deepEqual(silent.verdicts, []);
});
