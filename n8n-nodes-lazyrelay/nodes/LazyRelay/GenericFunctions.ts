import { randomBytes } from 'node:crypto';
import { NodeApiError } from 'n8n-workflow';
import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	JsonObject,
} from 'n8n-workflow';

export const CREDENTIAL_NAME = 'lazyRelayApi';
export const DEFAULT_BASE_URL = 'https://lazyrelaylazyrelay-backend.onrender.com/api';
export const REVIEW_LINK_PAGE = 'https://lazyrelay.com/review/';

type Ctx = IExecuteFunctions | ILoadOptionsFunctions;

export interface ApiOptions {
	body?: IDataObject | IHttpRequestOptions['body'];
	qs?: IDataObject;
	headers?: IDataObject;
}

/** Removes trailing slashes so `${base}${path}` never doubles them. */
export function normalizeBaseUrl(value: unknown): string {
	const raw = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_BASE_URL;
	return raw.replace(/\/+$/, '');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (value && typeof value === 'object') return value as Record<string, unknown>;
	if (typeof value === 'string') {
		try {
			const parsed: unknown = JSON.parse(value);
			if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/**
 * LazyRelay answers errors as `{ "error": "text" }`. Depending on the HTTP layer that body
 * shows up in a few different places on the thrown error, so look in each of them.
 */
export function extractApiMessage(error: unknown): string | undefined {
	const err = asRecord(error);
	if (!err) return undefined;
	const response = asRecord(err.response);
	const cause = asRecord(err.cause);
	const causeResponse = asRecord(cause?.response);
	const candidates: unknown[] = [
		response?.body,
		response?.data,
		err.error,
		err.body,
		causeResponse?.data,
		causeResponse?.body,
		asRecord(err.context)?.data,
	];
	for (const candidate of candidates) {
		const body = asRecord(candidate);
		if (body && typeof body.error === 'string' && body.error) return body.error;
		if (body && typeof body.message === 'string' && body.message && candidate !== err.error) {
			return body.message;
		}
	}
	return undefined;
}

/**
 * One place that talks to the LazyRelay REST API. Authentication (the Bearer header) is added by
 * n8n from the credential type, so the API key is never read or logged here.
 */
export async function lazyRelayApiRequest(
	this: Ctx,
	method: IHttpRequestMethods,
	path: string,
	options: ApiOptions = {},
): Promise<unknown> {
	const credentials = await this.getCredentials(CREDENTIAL_NAME);
	const requestOptions: IHttpRequestOptions = {
		method,
		url: `${normalizeBaseUrl(credentials.baseUrl)}${path}`,
		json: true,
	};
	if (options.body !== undefined) requestOptions.body = options.body;
	if (options.headers) requestOptions.headers = options.headers;
	if (options.qs && Object.keys(options.qs).length > 0) requestOptions.qs = options.qs;

	try {
		const response = await this.helpers.httpRequestWithAuthentication.call(
			this,
			CREDENTIAL_NAME,
			requestOptions,
		);
		// DELETE answers 204 with an empty body.
		if (response === '' || response === undefined || response === null) {
			return { success: true };
		}
		return response;
	} catch (error) {
		const message = extractApiMessage(error);
		throw new NodeApiError(this.getNode(), error as JsonObject, message ? { message } : undefined);
	}
}

/** "a, b ,c" becomes ["a","b","c"]. Arrays pass through. */
export function splitList(value: unknown): string[] {
	if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
	if (typeof value !== 'string') return [];
	return value
		.split(/[,\n]/)
		.map((v) => v.trim())
		.filter(Boolean);
}

const headerSafe = (value: string) => value.replace(/[\r\n"]/g, '_');

/**
 * Builds a multipart/form-data body by hand. n8n's HTTP helper only recognises the `form-data`
 * package, which community nodes may not depend on, so the body is a plain Buffer and the
 * Content-Type (with its boundary) is set explicitly.
 */
export function buildMultipartBody(
	file: { field: string; buffer: Buffer; fileName: string; mimeType: string },
	fields: Record<string, string> = {},
): { body: Buffer; contentType: string } {
	const boundary = `----LazyRelayN8n${randomBytes(12).toString('hex')}`;
	const chunks: Buffer[] = [];
	for (const [name, value] of Object.entries(fields)) {
		chunks.push(
			Buffer.from(
				`--${boundary}\r\nContent-Disposition: form-data; name="${headerSafe(name)}"\r\n\r\n${value}\r\n`,
				'utf8',
			),
		);
	}
	chunks.push(
		Buffer.from(
			`--${boundary}\r\nContent-Disposition: form-data; name="${headerSafe(file.field)}"; filename="${headerSafe(file.fileName)}"\r\nContent-Type: ${headerSafe(file.mimeType)}\r\n\r\n`,
			'utf8',
		),
		file.buffer,
		Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
	);
	return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}
