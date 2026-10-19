/**
 * One prompt to a bot on the Grok Bot computer (POWER UP → GROK BOT —
 * COMPUTER) and its report back: the gateway's listAgents, sendPrompt and
 * getAgentTranscriptTail, polled until the bot has stopped working. Shared by
 * GROK BOT SWARM's hand-off (server/providers/socialSwarm.js) and AI
 * DISTILLATION's teachers (server/shared/distillTeachers.mjs), so one bot runs
 * one task at a time whichever of them sent it.
 *
 * One budget, GROK_BOT_GATEWAY_TOTAL_MS from `startedAt`, covers every call;
 * a report counts only once the bot has stopped working, and the token never
 * appears in an error.
 */
import {
  GROK_BOT_GATEWAY_ANSWER_BYTES,
  GROK_BOT_GATEWAY_COMMAND_MS,
  GROK_BOT_GATEWAY_POLL_MS,
  GROK_BOT_GATEWAY_TOTAL_MS,
  GROK_BOT_GATEWAY_WAIT_MS,
  gatewayAgentAwaitingUser,
  gatewayAgentBusy,
  gatewayAgentId,
  gatewayErrorText,
  listGatewayAgents,
  pickGatewayAgent,
  readGatewayReply,
  sendPromptAccepted,
} from '../../src/grokBotGateway.mjs';

/** Bots on a task now (gateway origin + bot id): one task a bot at a time. */
const busyBots = new Set();

export class GrokBotComputerError extends Error {
  /** @param {string} message @param {number} status @param {string} code */
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Up to `limit` bytes of an answer as text; the rest is not read. */
export async function readCapped(response, limit) {
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of response.body || []) {
      total += chunk.length;
      if (total > limit) break;
      chunks.push(Buffer.from(chunk));
    }
  } catch {
    /* what arrived is enough */
  } finally {
    try {
      await response.body?.cancel();
    } catch {
      /* already closed */
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The bot's report on `prompt`. Throws GrokBotComputerError with the status
 * and words the caller passes on (codes: no-bot, no-bots, busy, not-taken,
 * awaiting, still-busy, unfinished, timeout); an aborted `signal` throws an
 * AbortError the caller should drop.
 *
 * @param {object} options
 * @param {{origin: string, token: string, named: string, agent: string}} options.gate grokBotGateway()
 * @param {string} options.prompt
 * @param {typeof fetch} options.fetchImpl
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.startedAt]
 * @param {string} [options.busyMessage]
 */
export async function askGrokBotComputer({
  gate,
  prompt,
  fetchImpl,
  signal,
  startedAt = Date.now(),
  busyMessage = 'Grok Bot is already on a task from this map. Wait for its report, then press again.',
}) {
  const deadlineAll = startedAt + GROK_BOT_GATEWAY_TOTAL_MS;
  const stop = signal || new AbortController().signal;
  const command = async (name, payload) => {
    const left = Math.min(
      GROK_BOT_GATEWAY_COMMAND_MS,
      deadlineAll - Date.now(),
    );
    if (left <= 0) {
      const err = new Error('Out of time');
      err.name = 'TimeoutError';
      throw err;
    }
    const response = await fetchImpl(`${gate.origin}/api/${name}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${gate.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(left), stop]),
    });
    const answer = await readCapped(response, GROK_BOT_GATEWAY_ANSWER_BYTES);
    let data = {};
    try {
      data = answer ? JSON.parse(answer) : {};
    } catch {
      data = { message: answer };
    }
    if (!response.ok)
      throw new GrokBotComputerError(
        gatewayErrorText(
          data?.error?.message || data?.error || data?.message || answer,
          response.status,
          gate.token,
        ),
        502,
        'gateway',
      );
    return data;
  };
  let lock = '';
  let taken = false;
  try {
    const roster = listGatewayAgents(await command('listAgents', {}));
    const chosen = pickGatewayAgent(roster, gate.named);
    if (!chosen)
      throw roster.length
        ? new GrokBotComputerError(
            `No Grok Bot named ${gate.agent}. Set BOT on POWER UP → GROK BOT — COMPUTER.`,
            502,
            'no-bot',
          )
        : new GrokBotComputerError(
            'No bots on that Grok Bot computer.',
            502,
            'no-bots',
          );
    const agentId = gatewayAgentId(chosen);
    const key = `${gate.origin} ${agentId}`;
    if (busyBots.has(key))
      throw new GrokBotComputerError(busyMessage, 409, 'busy');
    busyBots.add(key);
    lock = key;
    // The last line before the task: a new report must differ from it. When
    // it cannot be read, a report counts only after the bot was seen working.
    let before = '';
    let beforeKnown = true;
    try {
      before = readGatewayReply(
        await command('getAgentTranscriptTail', { id: agentId, limit: 12 }),
      );
    } catch (error) {
      if (stop.aborted) throw error;
      if (error?.name === 'TimeoutError' && Date.now() >= deadlineAll)
        throw error;
      beforeKnown = false;
    }
    const sent = await command('sendPrompt', { agentId, prompt });
    if (!sendPromptAccepted(sent))
      throw new GrokBotComputerError(
        'Grok Bot did not take the task.',
        502,
        'not-taken',
      );
    taken = true;
    // Room for one last pair of calls after the wait.
    const deadline = Math.min(
      Date.now() + GROK_BOT_GATEWAY_WAIT_MS,
      deadlineAll - GROK_BOT_GATEWAY_COMMAND_MS,
    );
    let sawBusy = false;
    let stillBusy = false;
    for (;;) {
      if (stop.aborted)
        throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
      const live = listGatewayAgents(await command('listAgents', {}));
      const row =
        live.find((item) => gatewayAgentId(item) === agentId) || chosen;
      if (gatewayAgentAwaitingUser(row))
        throw new GrokBotComputerError(
          'Grok Bot is waiting for you in the app (an approval). Finish it there, then press again.',
          504,
          'awaiting',
        );
      const busy = gatewayAgentBusy(row);
      if (busy) sawBusy = true;
      stillBusy = busy;
      const tail = readGatewayReply(
        await command('getAgentTranscriptTail', { id: agentId, limit: 12 }),
      );
      if (tail && !busy && (beforeKnown ? tail !== before : sawBusy))
        return tail;
      if (Date.now() + GROK_BOT_GATEWAY_POLL_MS > deadline) break;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, GROK_BOT_GATEWAY_POLL_MS);
        stop.addEventListener('abort', () => clearTimeout(timer), {
          once: true,
        });
      });
    }
    throw stillBusy
      ? new GrokBotComputerError(
          'Grok Bot is still working. Its report will be in its chat in Grok Bot.',
          504,
          'still-busy',
        )
      : new GrokBotComputerError(
          'Grok Bot did not finish in time.',
          504,
          'unfinished',
        );
  } catch (error) {
    if (error instanceof GrokBotComputerError || stop.aborted) throw error;
    const timedOut =
      error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw new GrokBotComputerError(
      timedOut
        ? taken
          ? 'Grok Bot did not finish in time. Its report will be in its chat in Grok Bot.'
          : 'Grok Bot did not take the task in time.'
        : error?.message && !String(error.message).includes(gate.token)
          ? error.message
          : 'The task could not reach Grok Bot.',
      error?.status || 504,
      timedOut ? 'timeout' : 'failed',
    );
  } finally {
    if (lock) busyBots.delete(lock);
  }
}
