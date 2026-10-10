/**
 * Talk to a running Grok Bot computer through its local HTTP gateway
 * (usually http://127.0.0.1:1340). No DOM and no network: URL checks live
 * in keySetupCore, and every request is built and every answer is read here.
 * The token never appears in an error string.
 */

/** The bot GROK BOT SWARM asks when BOT is left empty. */
export const GROK_BOT_GATEWAY_DEFAULT_AGENT = 'Chief of Staff';
/** Host unary calls are short; the wait for a finished report is separate. */
export const GROK_BOT_GATEWAY_COMMAND_MS = 20_000;
/** One sweep on that computer: search, browse, write. */
export const GROK_BOT_GATEWAY_WAIT_MS = 180_000;
export const GROK_BOT_GATEWAY_POLL_MS = 1_500;
/**
 * Everything one press may take on the server, from the first call to the
 * report: two short calls before the wait, the wait, and one call after.
 * The page waits a little longer than this for the server's answer.
 */
export const GROK_BOT_GATEWAY_TOTAL_MS =
  GROK_BOT_GATEWAY_WAIT_MS + 3 * GROK_BOT_GATEWAY_COMMAND_MS;
/** A transcript tail can be long; the reply is cut to REPLY_MAX after. */
export const GROK_BOT_GATEWAY_ANSWER_BYTES = 1024 * 1024;
const REPLY_MAX = 6000;

/**
 * Origin the token may be sent to: the URL POWER UP already accepted, with
 * no trailing slash and no path.
 */
export function grokBotGatewayOrigin(value) {
  try {
    const url = new URL(String(value ?? '').trim());
    return url.origin;
  } catch {
    return '';
  }
}

/** Agents in a listAgents answer: a bare array, or `{ agents }`. */
export function listGatewayAgents(data) {
  const rows = Array.isArray(data)
    ? data
    : Array.isArray(data?.agents)
      ? data.agents
      : [];
  return rows.filter((row) => row && typeof row === 'object');
}

export function gatewayAgentId(row) {
  return String(row?.id || row?.agentId || row?.uuid || '')
    .trim()
    .slice(0, 128);
}

export function gatewayAgentName(row) {
  return String(row?.name || row?.title || '').trim();
}

/**
 * The bot to send the sweep to. A named bot (id or name) must be there:
 * no hit is null, never another bot. With no name, a bot named Chief of
 * Staff, else the first bot on the computer. A saved BOT has no spaces, so
 * names match with - _ . ~ and spaces alike: Chief-of-Staff is Chief of Staff.
 */
export function pickGatewayAgent(agents, wanted = '') {
  const usable = listGatewayAgents(agents).filter((row) => gatewayAgentId(row));
  if (!usable.length) return null;
  const needle = String(wanted || '')
    .trim()
    .toLowerCase();
  if (needle) {
    const loose = looseAgentName(needle);
    const hit =
      usable.find((row) => gatewayAgentId(row).toLowerCase() === needle) ||
      usable.find((row) => looseAgentName(gatewayAgentName(row)) === loose);
    return hit || null;
  }
  const chief = usable.find((row) =>
    /chief\s*of\s*staff/i.test(gatewayAgentName(row)),
  );
  return chief || usable[0];
}

function looseAgentName(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s._~-]+/g, ' ')
    .trim();
}

export function gatewayAgentBusy(row) {
  if (!row || typeof row !== 'object') return false;
  return Boolean(
    row.isRunning || row.isComposingMessage || row.running || row.busy,
  );
}

export function gatewayAgentAwaitingUser(row) {
  return Boolean(row?.awaitingUserResponse);
}

/** Host sendPrompt is `{ accepted: true }` on 200; a false accepted is a miss. */
export function sendPromptAccepted(data) {
  return data?.accepted !== false;
}

function cleanReply(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, REPLY_MAX);
}

function asText(node) {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(asText).filter(Boolean).join('\n');
  if (!node || typeof node !== 'object') return '';
  if (typeof node.text === 'string') return node.text;
  if (typeof node.content === 'string') return node.content;
  if (Array.isArray(node.content)) return asText(node.content);
  if (typeof node.body === 'string') return node.body;
  return '';
}

function roleOf(node) {
  return String(node?.role || node?.speaker || node?.type || '').toLowerCase();
}

/**
 * The last assistant / send-message line in a transcript tail. User lines
 * and empty wrappers are ignored.
 */
export function readGatewayReply(data) {
  const found = [];
  const visit = (node, depth) => {
    if (depth > 8 || node == null) return;
    if (typeof node === 'string') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    const role = roleOf(node);
    if (
      role.includes('assistant') ||
      role === 'send-message' ||
      role === 'message'
    ) {
      const text = asText(node);
      if (text.trim()) found.push(text);
      return;
    }
    if (role.includes('user') || role.includes('human')) return;
    for (const key of [
      'messages',
      'entries',
      'items',
      'tail',
      'transcript',
      'output',
    ]) {
      if (key in node) visit(node[key], depth + 1);
    }
  };
  visit(data, 0);
  if (found.length) return cleanReply(found.at(-1));
  if (typeof data?.reply === 'string') return cleanReply(data.reply);
  if (typeof data?.text === 'string') return cleanReply(data.text);
  return '';
}

/** A refusal from the computer, short, and never carrying the token. */
export function gatewayErrorText(raw, status, token) {
  // Redact before cutting, so a cut never leaves part of the token.
  let text = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ');
  if (token) text = text.split(token).join('[key]');
  text = text
    .replace(/Bearer\s+\S+/gi, 'Bearer [key]')
    .trim()
    .slice(0, 200);
  return text
    ? `Grok Bot refused the task (HTTP ${status}): ${text}`
    : `Grok Bot refused the task (HTTP ${status})`;
}
