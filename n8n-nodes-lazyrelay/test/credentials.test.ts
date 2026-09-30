import { describe, expect, it } from 'vitest';
import { LazyRelayApi } from '../credentials/LazyRelayApi.credentials';

describe('LazyRelayApi credential', () => {
	const cred = new LazyRelayApi();
	it('has a password API key and a default base URL', () => {
		const key = cred.properties.find((p) => p.name === 'apiKey')!;
		expect(key.typeOptions).toEqual({ password: true });
		const base = cred.properties.find((p) => p.name === 'baseUrl')!;
		expect(base.default).toBe('https://lazyrelaylazyrelay-backend.onrender.com/api');
	});
	it('authenticates with a Bearer header', () => {
		expect(cred.authenticate).toEqual({
			type: 'generic',
			properties: { headers: { Authorization: '=Bearer {{$credentials.apiKey}}' } },
		});
	});
	it('tests with GET /social-accounts on the configured base URL', () => {
		expect(cred.test.request).toMatchObject({
			baseURL: '={{$credentials.baseUrl}}',
			url: '/social-accounts',
			method: 'GET',
		});
	});
});
