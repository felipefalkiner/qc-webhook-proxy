import 'dotenv/config';
import fs from 'fs';
import Fastify from 'fastify';

const { PORT = 3000 } = process.env;

const fastify = Fastify({ logger: true });

// ---------------------------------------------------------------------------
// Load webhook configuration
// ---------------------------------------------------------------------------

function loadWebhookConfigs() {
    const configs = JSON.parse(fs.readFileSync('./webhooks.json', 'utf8'));

    for (const [channel, config] of Object.entries(configs)) {
        if (!config.apiSecret || !config.webhookUrl) {
            throw new Error(
                `Channel '${channel}' is missing apiSecret or webhookUrl`
            );
        }
    }

    return configs;
}

let webhookConfigs = loadWebhookConfigs();

// ---------------------------------------------------------------------------
// Health check (no auth required)
// ---------------------------------------------------------------------------

fastify.get('/health', async () => ({ ok: true }));

// ---------------------------------------------------------------------------
// POST /notify/:channel
// ---------------------------------------------------------------------------

fastify.post('/notify/:channel', {
    schema: {
        params: {
            type: 'object',
            required: ['channel'],
            properties: {
                channel: { type: 'string', minLength: 1 },
            },
        },
        body: {
            type: 'object',
            required: ['content'],
            properties: {
                content: { type: 'string', minLength: 1, maxLength: 2000 },
            },
        },
    },
}, async (request, reply) => {

    const { channel } = request.params;
    const { content } = request.body;

    // --- Resolve config with lazy hot-reload ---

    let config = webhookConfigs[channel];

    if (!config) {
        fastify.log.info(
            `Channel '${channel}' not found in memory, reloading webhooks.json`
        );

        try {
            webhookConfigs = loadWebhookConfigs();
        } catch (err) {
            fastify.log.error({ err }, 'Failed to reload webhooks.json');
        }

        config = webhookConfigs[channel];

        if (!config) {
            return reply.code(404).send({ error: `Unknown channel '${channel}'` });
        }
    }

    if (config.enabled === false) {
        return reply.code(403).send({ error: `Channel '${channel}' is disabled` });
    }

    // --- Auth ---

    const authHeader = request.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
        return reply.code(401).send({ error: 'Missing Authorization header' });
    }

    const token = authHeader.slice(7);

    if (token !== config.apiSecret) {
        fastify.log.info(
            `Invalid token for channel '${channel}', reloading webhooks.json`
        );

        try {
            webhookConfigs = loadWebhookConfigs();
        } catch (err) {
            fastify.log.error({ err }, 'Failed to reload webhooks.json');
        }

        const refreshedConfig = webhookConfigs[channel];

        if (!refreshedConfig || token !== refreshedConfig.apiSecret) {
            return reply.code(403).send({ error: 'Invalid token' });
        }

        // Token is valid after reload — update config and continue
        config = refreshedConfig;
    }

    // --- Send ---

    const result = await sendToDiscord(config.webhookUrl, content);

    if (!result.ok) {
        return reply.code(result.status).send({ error: result.error });
    }

    return reply.code(200).send({ ok: true, channel });
});

// ---------------------------------------------------------------------------
// Discord sender with retry + exponential backoff
// ---------------------------------------------------------------------------

async function sendToDiscord(webhookUrl, content, attempt = 1) {
    const MAX_ATTEMPTS = 4;

    let response;

    try {
        response = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content }),
            signal: AbortSignal.timeout(5000),
        });
    } catch (err) {
        fastify.log.error({ err }, 'Network error reaching Discord');
        return { ok: false, status: 502, error: 'Could not reach Discord' };
    }

    // Discord success
    if (response.status === 204) {
        fastify.log.info({ webhook: webhookUrl }, 'Discord post successful');
        return { ok: true };
    }

    // Discord rate limit
    if (response.status === 429) {
        if (attempt >= MAX_ATTEMPTS) {
            fastify.log.warn(`Rate limited after ${MAX_ATTEMPTS} attempts`);
            return { ok: false, status: 429, error: 'Rate limited by Discord' };
        }

        let retryAfterMs = attempt * 2000;

        try {
            const body = await response.json();
            if (typeof body.retry_after === 'number') {
                retryAfterMs = Math.ceil(body.retry_after * 1000);
            }
        } catch (_) {}

        fastify.log.warn(`Rate limited. Retrying in ${retryAfterMs}ms`);
        await sleep(retryAfterMs);
        return sendToDiscord(webhookUrl, content, attempt + 1);
    }

    // Other errors
    const body = await response.text();
    fastify.log.error({ status: response.status, body }, 'Unexpected Discord response');
    return { ok: false, status: response.status, error: 'Failed to deliver message' };
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

try {
    await fastify.listen({ port: Number(PORT), host: '0.0.0.0' });
} catch (err) {
    fastify.log.error(err);
    process.exit(1);
}