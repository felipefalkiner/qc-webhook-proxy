import 'dotenv/config';
import Fastify from 'fastify';

const {
  DISCORD_WEBHOOK_URL,
  API_SECRET,
  PORT = 3000,
} = process.env;

if (!DISCORD_WEBHOOK_URL) throw new Error('Missing env: DISCORD_WEBHOOK_URL');
if (!API_SECRET)          throw new Error('Missing env: API_SECRET');

const fastify = Fastify({ logger: true });

// ---------------------------------------------------------------------------
// Auth hook — checks "Authorization: Bearer <secret>" on every request
// ---------------------------------------------------------------------------
fastify.addHook('onRequest', async (request, reply) => {
  const authHeader = request.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'Missing Authorization header' });
  }

  const token = authHeader.slice(7); // strip "Bearer "
  if (token !== API_SECRET) {
    return reply.code(403).send({ error: 'Invalid token' });
  }
});

// ---------------------------------------------------------------------------
// POST /notify  — forward message to Discord
// ---------------------------------------------------------------------------
fastify.post('/notify', {
  schema: {
    body: {
      type: 'object',
      required: ['content'],
      properties: {
        content: { type: 'string', minLength: 1, maxLength: 2000 },
      },
    },
  },
}, async (request, reply) => {
  const { content } = request.body;

  const result = await sendToDiscord(content);

  if (!result.ok) {
    return reply.code(result.status).send({ error: result.error });
  }

  return reply.code(200).send({ ok: true });
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
fastify.get('/health', async () => ({ ok: true }));

// ---------------------------------------------------------------------------
// Discord sender with retry + exponential backoff
// ---------------------------------------------------------------------------
async function sendToDiscord(content, attempt = 1) {
  const MAX_ATTEMPTS = 4;

  let response;
  try {
    response = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
  } catch (err) {
    fastify.log.error({ err }, 'Network error reaching Discord');
    return { ok: false, status: 502, error: 'Could not reach Discord' };
  }

  // 204 = success (Discord returns no body on webhook posts)
  if (response.status === 204) {
    fastify.log.info('Discord post successful');
    return { ok: true };
  }

  // Rate limited — respect Discord's retry_after
  if (response.status === 429) {
    if (attempt >= MAX_ATTEMPTS) {
      fastify.log.warn(`Rate limited after ${MAX_ATTEMPTS} attempts, giving up`);
      return { ok: false, status: 429, error: 'Rate limited by Discord' };
    }

    let retryAfterMs = attempt * 2000; // fallback: 2s, 4s, 6s
    try {
      const body = await response.json();
      if (typeof body.retry_after === 'number') {
        retryAfterMs = Math.ceil(body.retry_after * 1000);
      }
    } catch (_) { /* ignore parse errors */ }

    fastify.log.warn(`Rate limited (attempt ${attempt}). Retrying in ${retryAfterMs}ms...`);
    await sleep(retryAfterMs);
    return sendToDiscord(content, attempt + 1);
  }

  // Any other error
  const body = await response.text();
  fastify.log.error({ status: response.status, body }, 'Unexpected Discord response');
  return { ok: false, status: response.status, error: `Discord error: ${body}` };
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

try {
  await fastify.listen({ port: Number(PORT), host: '0.0.0.0' });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
