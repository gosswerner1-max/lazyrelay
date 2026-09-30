import { describe, expect, it } from 'vitest';
import { LazyRelay } from '../nodes/LazyRelay/LazyRelay.node';
import { BASE, httpError, last, makeExecuteCtx } from './mocks';

const node = new LazyRelay();
const run = (opts: Parameters<typeof makeExecuteCtx>[0]) => {
	const { ctx, request } = makeExecuteCtx(opts);
	return { request, promise: node.execute.call(ctx) };
};
const post = (operation: string, params: Record<string, unknown> = {}) => ({
	resource: 'post',
	operation,
	...params,
});

describe('Post operations', () => {
	it('Schedule: POST /scheduled-posts with common fields', async () => {
		const { request, promise } = run({
			params: post('schedule', {
				socialAccountId: 'acc1',
				content: 'Hello',
				scheduledFor: '2026-10-01T09:00:00Z',
				mediaUrl: 'https://x.test/a.jpg',
				requiresApproval: true,
			}),
			respond: () => ({ id: 'p1', status: 'needs_approval' }),
		});
		const out = await promise;
		const req = last(request);
		expect(req.method).toBe('POST');
		expect(req.url).toBe(`${BASE}/scheduled-posts`);
		expect(req.body).toEqual({
			socialAccountId: 'acc1',
			content: 'Hello',
			scheduledFor: '2026-10-01T09:00:00.000Z',
			mediaUrl: 'https://x.test/a.jpg',
			requiresApproval: true,
		});
		expect(request.mock.calls[0][0]).toBe('lazyRelayApi');
		expect(out[0][0]).toEqual({
			json: { id: 'p1', status: 'needs_approval' },
			pairedItem: { item: 0 },
		});
	});

	it('Schedule: omits empty media and approval=false', async () => {
		const { request, promise } = run({
			params: post('schedule', {
				socialAccountId: 'a',
				content: 'c',
				scheduledFor: '2026-10-01T09:00:00Z',
				mediaUrl: '',
				requiresApproval: false,
			}),
		});
		await promise;
		expect(last(request).body).toEqual({
			socialAccountId: 'a',
			content: 'c',
			scheduledFor: '2026-10-01T09:00:00.000Z',
		});
	});

	it('Additional Fields map to the API field names', async () => {
		const { request, promise } = run({
			params: post('schedule', {
				socialAccountId: 'a',
				content: 'c',
				scheduledFor: '2026-10-01T09:00:00Z',
				additionalFields: {
					mediaUrls: 'https://x.test/2.jpg, https://x.test/3.jpg',
					tags: 'spring, launch',
					firstComment: 'first!',
					selfReplyText: 'thanks',
					selfReplyAtLikes: 25,
					coverImageUrl: 'https://x.test/cover.jpg',
					mediaAltText: 'a cat',
					boardId: 'board9',
					destinationLink: 'https://x.test/go',
					tiktokPrivacyLevel: 'SELF_ONLY',
					tiktokDisableComment: false,
					tiktokDisableDuet: true,
					tiktokDisableStitch: true,
					tiktokBrandOrganic: true,
					tiktokBrandContent: false,
					options: '{"youtube":{"title":"T","privacy":"unlisted"}}',
				},
			}),
		});
		await promise;
		expect(last(request).body).toEqual({
			socialAccountId: 'a',
			content: 'c',
			scheduledFor: '2026-10-01T09:00:00.000Z',
			mediaUrls: ['https://x.test/2.jpg', 'https://x.test/3.jpg'],
			tags: ['spring', 'launch'],
			firstComment: 'first!',
			selfReplyText: 'thanks',
			selfReplyAtLikes: 25,
			coverImageUrl: 'https://x.test/cover.jpg',
			mediaAltText: 'a cat',
			boardId: 'board9',
			destinationLink: 'https://x.test/go',
			tiktokPrivacyLevel: 'SELF_ONLY',
			tiktokDisableComment: false,
			tiktokDisableDuet: true,
			tiktokDisableStitch: true,
			tiktokBrandOrganic: true,
			tiktokBrandContent: false,
			options: { youtube: { title: 'T', privacy: 'unlisted' } },
		});
	});

	it('accepts the options field as an object and skips an empty {}', async () => {
		const a = run({
			params: post('createDraft', {
				content: 'c',
				additionalFields: { options: { instagram: { placement: 'reel' } } },
			}),
		});
		await a.promise;
		expect(last(a.request).body.options).toEqual({ instagram: { placement: 'reel' } });
		const b = run({ params: post('createDraft', { content: 'c', additionalFields: { options: '{}' } }) });
		await b.promise;
		expect(last(b.request).body).toEqual({ content: 'c' });
	});

	it('rejects invalid options JSON with a clear message', async () => {
		const { promise } = run({
			params: post('createDraft', { content: 'c', additionalFields: { options: '{nope' } }),
		});
		await expect(promise).rejects.toThrow('Platform Options (JSON) is not valid JSON');
	});

	it('rejects an invalid Scheduled For date', async () => {
		const { request, promise } = run({
			params: post('schedule', { socialAccountId: 'a', content: 'c', scheduledFor: 'not a date' }),
		});
		await expect(promise).rejects.toThrow('not a valid date');
		expect(request).not.toHaveBeenCalled();
	});

	it('Publish Now: POST /scheduled-posts with scheduledFor = now', async () => {
		const before = Date.now();
		const { request, promise } = run({
			params: post('publishNow', {
				socialAccountId: 'a',
				content: 'now',
				mediaUrl: 'https://x.test/v.mp4',
				additionalFields: { tags: 'x' },
			}),
		});
		await promise;
		const req = last(request);
		expect(req.method).toBe('POST');
		expect(req.url).toBe(`${BASE}/scheduled-posts`);
		const { scheduledFor, ...rest } = req.body;
		expect(rest).toEqual({
			socialAccountId: 'a',
			content: 'now',
			mediaUrl: 'https://x.test/v.mp4',
			tags: ['x'],
		});
		expect(new Date(scheduledFor).getTime()).toBeGreaterThanOrEqual(before);
		expect(new Date(scheduledFor).getTime()).toBeLessThanOrEqual(Date.now());
	});

	it('Create Draft: POST /scheduled-posts/draft without account or time', async () => {
		const { request, promise } = run({ params: post('createDraft', { content: 'idea', mediaUrl: '' }) });
		await promise;
		const req = last(request);
		expect(req.method).toBe('POST');
		expect(req.url).toBe(`${BASE}/scheduled-posts/draft`);
		expect(req.body).toEqual({ content: 'idea' });
	});

	it('Schedule Draft: PATCH /scheduled-posts/:id/schedule', async () => {
		const { request, promise } = run({
			params: post('scheduleDraft', {
				postId: 'd/1',
				socialAccountId: 'a',
				content: 'final',
				scheduledFor: '2026-11-02T10:30:00Z',
				requiresApproval: true,
			}),
		});
		await promise;
		const req = last(request);
		expect(req.method).toBe('PATCH');
		expect(req.url).toBe(`${BASE}/scheduled-posts/d%2F1/schedule`);
		expect(req.body).toEqual({
			socialAccountId: 'a',
			content: 'final',
			scheduledFor: '2026-11-02T10:30:00.000Z',
			requiresApproval: true,
		});
	});

	it('Update: PATCH /scheduled-posts/:id with only the chosen fields', async () => {
		const { request, promise } = run({
			params: post('update', {
				postId: 'p1',
				updateFields: { content: 'edited', tags: 'a,b', mediaUrl: 'https://x.test/n.png' },
			}),
		});
		await promise;
		const req = last(request);
		expect(req.method).toBe('PATCH');
		expect(req.url).toBe(`${BASE}/scheduled-posts/p1`);
		expect(req.body).toEqual({ content: 'edited', tags: ['a', 'b'], mediaUrl: 'https://x.test/n.png' });
	});

	it('Update: refuses an empty update', async () => {
		const { request, promise } = run({ params: post('update', { postId: 'p1', updateFields: {} }) });
		await expect(promise).rejects.toThrow('Add at least one field');
		expect(request).not.toHaveBeenCalled();
	});

	it('Delete: DELETE /scheduled-posts/:id and handles the empty 204 body', async () => {
		const { request, promise } = run({ params: post('delete', { postId: 'p1' }), respond: () => '' });
		const out = await promise;
		const req = last(request);
		expect(req.method).toBe('DELETE');
		expect(req.url).toBe(`${BASE}/scheduled-posts/p1`);
		expect(req.body).toBeUndefined();
		expect(out[0][0].json).toEqual({ success: true, id: 'p1' });
	});

	it('Approve: PATCH /scheduled-posts/:id/approve', async () => {
		const { request, promise } = run({ params: post('approve', { postId: 'p1' }) });
		await promise;
		const req = last(request);
		expect([req.method, req.url]).toEqual(['PATCH', `${BASE}/scheduled-posts/p1/approve`]);
		expect(req.body).toBeUndefined();
	});

	it('Get Proof Link: GET /scheduled-posts/:id/proof-link', async () => {
		const { request, promise } = run({
			params: post('getProofLink', { postId: 'p1' }),
			respond: () => ({ url: 'https://lazyrelay.com/verify/r1' }),
		});
		const out = await promise;
		const req = last(request);
		expect([req.method, req.url]).toEqual(['GET', `${BASE}/scheduled-posts/p1/proof-link`]);
		expect(out[0][0].json).toEqual({ url: 'https://lazyrelay.com/verify/r1' });
	});

	const posts = [
		{ id: '1', status: 'pending', social_account_id: 'a' },
		{ id: '2', status: 'posted', social_account_id: 'a' },
		{ id: '3', status: 'pending', social_account_id: 'b' },
		{ id: '4', status: 'pending', social_account_id: 'a' },
	];

	it('Get Many: GET /scheduled-posts, filters by status and account, one item per post', async () => {
		const { request, promise } = run({
			params: post('getAll', {
				returnAll: true,
				filters: { status: 'pending', socialAccountId: 'a', brand: 'Acme' },
			}),
			respond: () => posts,
		});
		const out = await promise;
		const req = last(request);
		expect([req.method, req.url]).toEqual(['GET', `${BASE}/scheduled-posts`]);
		expect(req.qs).toEqual({ brand: 'Acme' });
		expect(out[0].map((i) => i.json.id)).toEqual(['1', '4']);
		expect(out[0].every((i) => (i.pairedItem as { item: number }).item === 0)).toBe(true);
	});

	it('Get Many: honours the limit', async () => {
		const { promise } = run({
			params: post('getAll', { returnAll: false, limit: 2, filters: {} }),
			respond: () => posts,
		});
		const out = await promise;
		expect(out[0]).toHaveLength(2);
	});
});

describe('Other resources', () => {
	it('Account: Get Many', async () => {
		const { request, promise } = run({
			params: { resource: 'account', operation: 'getAll' },
			respond: () => [
				{ id: 'a', platform: 'x' },
				{ id: 'b', platform: 'bluesky' },
			],
		});
		const out = await promise;
		const req = last(request);
		expect([req.method, req.url]).toEqual(['GET', `${BASE}/social-accounts`]);
		expect(out[0]).toHaveLength(2);
	});

	it('Platform Rules: Get with and without a platform', async () => {
		const a = run({ params: { resource: 'platformRules', operation: 'get', platform: 'tiktok' } });
		await a.promise;
		const ra = last(a.request);
		expect([ra.method, ra.url, ra.qs]).toEqual(['GET', `${BASE}/platforms/rules`, { platform: 'tiktok' }]);
		const b = run({ params: { resource: 'platformRules', operation: 'get', platform: '' } });
		await b.promise;
		expect(last(b.request).qs).toBeUndefined();
	});

	it('Media Upload: multipart POST /media/upload with field "file"', async () => {
		const { request, promise } = run({
			params: { resource: 'media', operation: 'upload', binaryPropertyName: 'data', altText: 'a red car' },
			items: [{ json: {}, binary: { data: { data: 'x', mimeType: 'image/png', fileName: 'car.png' } } }],
			buffer: Buffer.from([137, 80, 78, 71]),
			respond: () => ({ id: 'm1', url: 'https://cdn.test/m1.png', altText: 'a red car' }),
		});
		const out = await promise;
		const req = last(request);
		expect([req.method, req.url]).toEqual(['POST', `${BASE}/media/upload`]);
		const contentType = (req.headers as { 'Content-Type': string })['Content-Type'];
		expect(contentType).toMatch(/^multipart\/form-data; boundary=.+/);
		const boundary = contentType.split('boundary=')[1];
		expect(Buffer.isBuffer(req.body)).toBe(true);
		const text = (req.body as Buffer).toString('latin1');
		const CRLF = '\r\n';
		expect(text.startsWith(`--${boundary}${CRLF}`)).toBe(true);
		expect(text.trimEnd().endsWith(`--${boundary}--`)).toBe(true);
		expect(text).toContain(`Content-Disposition: form-data; name="altText"${CRLF}${CRLF}a red car${CRLF}`);
		expect(text).toContain(
			`Content-Disposition: form-data; name="file"; filename="car.png"${CRLF}Content-Type: image/png${CRLF}${CRLF}`,
		);
		// the file bytes sit exactly between the part header and the closing boundary
		const fileBytes = Buffer.from([137, 80, 78, 71]).toString('latin1');
		expect(text).toContain(`${CRLF}${CRLF}${fileBytes}${CRLF}--${boundary}--`);
		expect(out[0][0].json.url).toBe('https://cdn.test/m1.png');
	});

	it('Media Upload: clear error when the binary field is missing', async () => {
		const { request, promise } = run({
			params: { resource: 'media', operation: 'upload', binaryPropertyName: 'data' },
		});
		await expect(promise).rejects.toThrow('No binary data found in field "data"');
		expect(request).not.toHaveBeenCalled();
	});

	it('Posting Slot: Get Next Free Slot', async () => {
		const { request, promise } = run({
			params: { resource: 'postingSlot', operation: 'getNextFree', socialAccountId: 'a1' },
			respond: () => ({ scheduledFor: '2026-10-01T07:00:00.000Z' }),
		});
		const out = await promise;
		const req = last(request);
		expect([req.method, req.url, req.qs]).toEqual([
			'GET',
			`${BASE}/posting-slots/next`,
			{ socialAccountId: 'a1' },
		]);
		expect(out[0][0].json.scheduledFor).toBe('2026-10-01T07:00:00.000Z');
	});

	it('Analytics: Get Summary with days, brand and tag', async () => {
		const { request, promise } = run({
			params: {
				resource: 'analytics',
				operation: 'getSummary',
				days: 7,
				filters: { brand: 'Acme', tag: 'launch' },
			},
		});
		await promise;
		const req = last(request);
		expect([req.method, req.url, req.qs]).toEqual([
			'GET',
			`${BASE}/analytics/summary`,
			{ days: 7, brand: 'Acme', tag: 'launch' },
		]);
	});

	it('Analytics: days defaults to 30 and empty filters are left out', async () => {
		const { request, promise } = run({
			params: { resource: 'analytics', operation: 'getSummary', filters: {} },
		});
		await promise;
		expect(last(request).qs).toEqual({ days: 30 });
	});

	it('Review Link: Create returns the public URL', async () => {
		const { request, promise } = run({
			params: {
				resource: 'reviewLink',
				operation: 'create',
				additionalFields: { label: 'Acme', brandLabel: 'Acme Co', expiresInDays: 14 },
			},
			respond: () => ({ id: 'l1', token: 'tok123', status: 'active' }),
		});
		const out = await promise;
		const req = last(request);
		expect([req.method, req.url]).toEqual(['POST', `${BASE}/review-links`]);
		expect(req.body).toEqual({ label: 'Acme', brandLabel: 'Acme Co', expiresInDays: 14 });
		expect(out[0][0].json).toEqual({
			id: 'l1',
			token: 'tok123',
			status: 'active',
			url: 'https://lazyrelay.com/review/tok123',
		});
	});

	it('Review Link: Get Many yields one item per link', async () => {
		const { request, promise } = run({
			params: { resource: 'reviewLink', operation: 'getAll' },
			respond: () => ({
				maxLinks: 5,
				links: [
					{ id: 'l1', token: 't1' },
					{ id: 'l2', token: 't2' },
				],
			}),
		});
		const out = await promise;
		const req = last(request);
		expect([req.method, req.url]).toEqual(['GET', `${BASE}/review-links`]);
		expect(out[0].map((i) => i.json.id)).toEqual(['l1', 'l2']);
	});

	it('Review Link: Revoke', async () => {
		const { request, promise } = run({
			params: { resource: 'reviewLink', operation: 'revoke', linkId: 'l1' },
			respond: () => ({ revoked: true }),
		});
		const out = await promise;
		const req = last(request);
		expect([req.method, req.url]).toEqual(['DELETE', `${BASE}/review-links/l1`]);
		expect(out[0][0].json).toEqual({ revoked: true });
	});
});

describe('Requests, errors and items', () => {
	it('honours a custom base URL and trims trailing slashes', async () => {
		const { request, promise } = run({
			baseUrl: 'https://api.example.test/api//',
			params: { resource: 'account', operation: 'getAll' },
		});
		await promise;
		expect(last(request).url).toBe('https://api.example.test/api/social-accounts');
	});

	it('never puts the API key on the request (n8n adds the header from the credential)', async () => {
		const { request, promise } = run({ params: { resource: 'account', operation: 'getAll' } });
		await promise;
		expect(JSON.stringify(request.mock.calls)).not.toContain('lzr_live_SECRET');
	});

	it('surfaces the API error text', async () => {
		const { promise } = run({
			params: post('schedule', {
				socialAccountId: 'a',
				content: 'c',
				scheduledFor: '2026-10-01T09:00:00Z',
			}),
			respond: () => {
				throw httpError(400, 'tiktokPrivacyLevel is required for TikTok');
			},
		});
		await expect(promise).rejects.toMatchObject({
			name: 'NodeApiError',
			message: 'tiktokPrivacyLevel is required for TikTok',
		});
	});

	it('surfaces the API error text from other error shapes', async () => {
		for (const shape of [
			{ error: { error: 'Nope A' } },
			{ cause: { response: { data: { error: 'Nope A' } } } },
			{ response: { data: '{"error":"Nope A"}' } },
		]) {
			const { promise } = run({
				params: { resource: 'account', operation: 'getAll' },
				respond: () => {
					throw Object.assign(new Error('Request failed'), shape);
				},
			});
			await expect(promise).rejects.toMatchObject({ message: 'Nope A' });
		}
	});

	it('continueOnFail returns an error item and keeps going', async () => {
		let n = 0;
		const { promise } = run({
			continueOnFail: true,
			items: [{ json: { n: 1 } }, { json: { n: 2 } }],
			params: { resource: 'analytics', operation: 'getSummary', filters: {} },
			respond: () => {
				if (n++ === 0) throw httpError(403, 'Plan limit reached');
				return { total: 3 };
			},
		});
		const out = await promise;
		expect(out[0]).toEqual([
			{ json: { error: 'Plan limit reached' }, pairedItem: { item: 0 } },
			{ json: { total: 3 }, pairedItem: { item: 1 } },
		]);
	});

	it('returns one result per input item with pairedItem set', async () => {
		const { request, promise } = run({
			items: [{ json: {} }, { json: {} }, { json: {} }],
			params: { resource: 'postingSlot', operation: 'getNextFree', socialAccountId: 'a' },
			respond: (_o, i) => ({ scheduledFor: `t${i}` }),
		});
		const out = await promise;
		expect(request).toHaveBeenCalledTimes(3);
		expect(out[0].map((i) => [i.json.scheduledFor, (i.pairedItem as { item: number }).item])).toEqual([
			['t0', 0],
			['t1', 1],
			['t2', 2],
		]);
	});

	it('throws a NodeOperationError for an unknown operation', async () => {
		const { promise } = run({ params: { resource: 'post', operation: 'explode' } });
		await expect(promise).rejects.toThrow('not supported');
	});
});

describe('loadOptions', () => {
	it('getSocialAccounts lists platform and name from /social-accounts', async () => {
		const { ctx, request } = makeExecuteCtx({
			respond: () => [
				{ id: 'a1', platform: 'instagram', display_name: 'Acme IG', brand_label: 'Acme' },
				{
					id: 'a2',
					platform: 'x',
					display_name: null,
					platform_account_id: 'acme_x',
					needs_reconnect_at: '2026-09-01',
				},
			],
		});
		const options = await node.methods.loadOptions.getSocialAccounts.call(ctx);
		expect(last(request).url).toBe(`${BASE}/social-accounts`);
		expect(options).toEqual([
			{ name: 'instagram: Acme IG', value: 'a1', description: 'Brand: Acme' },
			{ name: 'x: acme_x (needs reconnecting)', value: 'a2', description: undefined },
		]);
	});
});

describe('description', () => {
	it('declares all resources and the credential', () => {
		const resource = node.description.properties.find((p) => p.name === 'resource')!;
		expect((resource.options as Array<{ value: string }>).map((o) => o.value).sort()).toEqual(
			['account', 'analytics', 'media', 'platformRules', 'post', 'postingSlot', 'reviewLink'].sort(),
		);
		expect(node.description.credentials).toEqual([{ name: 'lazyRelayApi', required: true }]);
	});

	it('has no em or en dashes in any user-facing text', () => {
		expect(JSON.stringify(node.description)).not.toMatch(/[–—]/);
	});
});
