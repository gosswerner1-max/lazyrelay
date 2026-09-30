import { vi } from 'vitest';
import type { IDataObject, INodeExecutionData } from 'n8n-workflow';

export const BASE = 'https://lazyrelaylazyrelay-backend.onrender.com/api';

export interface CtxOptions {
	params?: Record<string, unknown>;
	items?: INodeExecutionData[];
	continueOnFail?: boolean;
	baseUrl?: string;
	/** Called for each request; return the response body or throw to simulate an HTTP error. */
	respond?: (options: any, callIndex: number) => unknown;
	buffer?: Buffer;
}

export function makeExecuteCtx(opts: CtxOptions = {}) {
	const items = opts.items ?? [{ json: {} }];
	const request = vi.fn(async (_cred: string, options: any) => {
		const n = request.mock.calls.length - 1;
		return opts.respond ? opts.respond(options, n) : {};
	});
	const params = opts.params ?? {};
	const ctx: any = {
		getInputData: () => items,
		getNodeParameter: (name: string, _i: number, fallback?: unknown) =>
			name in params ? params[name] : fallback,
		getCredentials: vi.fn(async () => ({
			apiKey: 'lzr_live_SECRET',
			baseUrl: opts.baseUrl ?? BASE,
		})),
		getNode: () => ({
			name: 'LazyRelay',
			type: 'lazyRelay',
			typeVersion: 1,
			id: '1',
			position: [0, 0],
			parameters: {},
		}),
		continueOnFail: () => opts.continueOnFail ?? false,
		helpers: {
			httpRequestWithAuthentication: request,
			getBinaryDataBuffer: vi.fn(async () => opts.buffer ?? Buffer.from('PNGDATA')),
		},
	};
	return { ctx, request };
}

/** What n8n's HTTP helper throws for a 4xx: the API body sits on the error. */
export function httpError(status: number, message: string): Error {
	return Object.assign(new Error(`Request failed with status code ${status}`), {
		httpCode: String(status),
		response: { status, body: { error: message } },
	});
}

type Req = IDataObject & { method: string; url: string; body?: any; qs?: any };

export const last = (request: { mock: { calls: any[][] } }) =>
	request.mock.calls[request.mock.calls.length - 1][1] as Req;
