import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { LazyRelayTrigger, verifySignature } from '../nodes/LazyRelayTrigger/LazyRelayTrigger.node';

const SECRET = 'a'.repeat(64);
const ALL_EVENTS = ['post.verified', 'post.failed', 'post.unconfirmed', 'channel.needs_reconnect'];
const sign = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('hex');

function makeWebhookCtx(opts: {
	body: object | string;
	secret?: string;
	signatureFor?: string;
	header?: string | null;
	events?: string[];
	rawBody?: Buffer | string | null;
}) {
	const raw = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
	const parsed = typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body;
	const headers: Record<string, string> = {};
	if (opts.header !== null) {
		headers['x-lazyrelay-signature'] = opts.header ?? sign(opts.signatureFor ?? SECRET, raw);
	}
	const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
	const req: Record<string, unknown> = {};
	if (opts.rawBody !== null) req.rawBody = opts.rawBody ?? Buffer.from(raw);
	const ctx: any = {
		getRequestObject: () => req,
		getResponseObject: () => res,
		getBodyData: () => parsed,
		getHeaderData: () => headers,
		getNodeParameter: (name: string, fallback?: unknown) => {
			if (name === 'webhookSecret') return opts.secret ?? SECRET;
			if (name === 'events') return opts.events ?? ALL_EVENTS;
			return fallback;
		},
	};
	return { ctx, res };
}

const trigger = new LazyRelayTrigger();
const payload = {
	event: 'post.verified',
	eventId: 'e1',
	createdAt: '2026-09-30T10:00:00Z',
	postId: 'p1',
	platform: 'x',
};

describe('verifySignature', () => {
	const body = JSON.stringify(payload);
	it('accepts a valid signature (Buffer and string bodies)', () => {
		expect(verifySignature(SECRET, body, sign(SECRET, body))).toBe(true);
		expect(verifySignature(SECRET, Buffer.from(body), sign(SECRET, body))).toBe(true);
	});
	it('accepts an uppercase hex signature', () => {
		expect(verifySignature(SECRET, body, sign(SECRET, body).toUpperCase())).toBe(true);
	});
	it('rejects a tampered body', () => {
		expect(verifySignature(SECRET, body.replace('p1', 'p2'), sign(SECRET, body))).toBe(false);
	});
	it('rejects the wrong secret', () => {
		expect(verifySignature('b'.repeat(64), body, sign(SECRET, body))).toBe(false);
	});
	it('rejects a missing, empty or wrong-length header', () => {
		expect(verifySignature(SECRET, body, undefined)).toBe(false);
		expect(verifySignature(SECRET, body, '')).toBe(false);
		expect(verifySignature(SECRET, body, 'abc')).toBe(false);
	});
	it('rejects when no secret is configured, even for a signature made with an empty key', () => {
		expect(verifySignature('', body, sign('', body))).toBe(false);
	});
});

describe('webhook()', () => {
	it('valid delivery: passes the parsed payload out', async () => {
		const { ctx, res } = makeWebhookCtx({ body: payload });
		const out = await trigger.webhook.call(ctx);
		expect(out.workflowData).toEqual([[{ json: payload }]]);
		expect(res.status).not.toHaveBeenCalled();
	});

	it('tampered body: 401 and no workflow run', async () => {
		const { ctx, res } = makeWebhookCtx({
			body: payload,
			header: sign(SECRET, JSON.stringify({ ...payload, postId: 'other' })),
		});
		const out = await trigger.webhook.call(ctx);
		expect(res.status).toHaveBeenCalledWith(401);
		expect(out.workflowData).toBeUndefined();
		expect(out.noWebhookResponse).toBe(true);
	});

	it('wrong secret: 401', async () => {
		const { ctx, res } = makeWebhookCtx({ body: payload, signatureFor: 'c'.repeat(64) });
		const out = await trigger.webhook.call(ctx);
		expect(res.status).toHaveBeenCalledWith(401);
		expect(out.workflowData).toBeUndefined();
	});

	it('missing signature header: 401', async () => {
		const { ctx, res } = makeWebhookCtx({ body: payload, header: null });
		const out = await trigger.webhook.call(ctx);
		expect(res.status).toHaveBeenCalledWith(401);
		expect(out.workflowData).toBeUndefined();
	});

	it('empty configured secret: 401', async () => {
		const { ctx, res } = makeWebhookCtx({ body: payload, secret: '   ' });
		await trigger.webhook.call(ctx);
		expect(res.status).toHaveBeenCalledWith(401);
	});

	it('verifies against the RAW body, not a re-serialised one', async () => {
		// Same JSON content with different whitespace: a signature over the raw text matches it,
		// and a signature over the compact form must NOT match the spaced raw body.
		const spaced = JSON.stringify(payload, null, 2);
		const ok = makeWebhookCtx({ body: spaced, rawBody: Buffer.from(spaced), header: sign(SECRET, spaced) });
		expect((await trigger.webhook.call(ok.ctx)).workflowData).toBeDefined();
		const bad = makeWebhookCtx({
			body: spaced,
			rawBody: Buffer.from(spaced),
			header: sign(SECRET, JSON.stringify(payload)),
		});
		await trigger.webhook.call(bad.ctx);
		expect(bad.res.status).toHaveBeenCalledWith(401);
	});

	it('falls back to the serialised body when n8n gives no raw body', async () => {
		const { ctx } = makeWebhookCtx({ body: payload, rawBody: null });
		expect((await trigger.webhook.call(ctx)).workflowData).toEqual([[{ json: payload }]]);
	});

	it('webhook.test: answered 200, workflow not run', async () => {
		const test = {
			event: 'webhook.test',
			eventId: 't1',
			createdAt: 'x',
			message: 'This is a test event from LazyRelay.',
		};
		const { ctx, res } = makeWebhookCtx({ body: test });
		const out = await trigger.webhook.call(ctx);
		expect(res.status).toHaveBeenCalledWith(200);
		expect(out.workflowData).toBeUndefined();
		expect(out.noWebhookResponse).toBe(true);
	});

	it('webhook.test with a bad signature is still a 401', async () => {
		const { ctx, res } = makeWebhookCtx({ body: { event: 'webhook.test' }, signatureFor: 'd'.repeat(64) });
		await trigger.webhook.call(ctx);
		expect(res.status).toHaveBeenCalledWith(401);
	});

	it('event filter: unselected events are answered 200 and ignored', async () => {
		const { ctx, res } = makeWebhookCtx({ body: { ...payload, event: 'post.failed' }, events: ['post.verified'] });
		const out = await trigger.webhook.call(ctx);
		expect(res.status).toHaveBeenCalledWith(200);
		expect(out.workflowData).toBeUndefined();
	});

	it('event filter: selected events run', async () => {
		const failed = { ...payload, event: 'post.failed', reason: 'boom' };
		const { ctx } = makeWebhookCtx({ body: failed, events: ['post.failed', 'channel.needs_reconnect'] });
		expect((await trigger.webhook.call(ctx)).workflowData).toEqual([[{ json: failed }]]);
	});

	it('event filter: an empty selection accepts every event', async () => {
		const ev = { event: 'channel.needs_reconnect', eventId: 'e', socialAccountId: 's1' };
		const { ctx } = makeWebhookCtx({ body: ev, events: [] });
		expect((await trigger.webhook.call(ctx)).workflowData).toEqual([[{ json: ev }]]);
	});
});

describe('lifecycle and description', () => {
	it('activation hooks do nothing on the API (endpoints are made by hand in LazyRelay)', async () => {
		const ctx: any = { helpers: { httpRequest: vi.fn(), httpRequestWithAuthentication: vi.fn() } };
		const m = trigger.webhookMethods.default;
		expect(await m.checkExists.call(ctx)).toBe(true);
		expect(await m.create.call(ctx)).toBe(true);
		expect(await m.delete.call(ctx)).toBe(true);
		expect(ctx.helpers.httpRequest).not.toHaveBeenCalled();
		expect(ctx.helpers.httpRequestWithAuthentication).not.toHaveBeenCalled();
	});

	it('declares one POST webhook, a password secret and the four events', () => {
		const d = trigger.description;
		expect(d.webhooks).toHaveLength(1);
		expect(d.webhooks![0].httpMethod).toBe('POST');
		expect(d.inputs).toEqual([]);
		expect(d.credentials).toBeUndefined();
		const secret = d.properties.find((p) => p.name === 'webhookSecret')!;
		expect(secret.typeOptions).toEqual({ password: true });
		expect(secret.required).toBe(true);
		const events = d.properties.find((p) => p.name === 'events')!;
		expect((events.options as Array<{ value: string }>).map((o) => o.value).sort()).toEqual(
			[...ALL_EVENTS].sort(),
		);
		expect(JSON.stringify(d)).not.toMatch(/[–—]/);
	});
});
