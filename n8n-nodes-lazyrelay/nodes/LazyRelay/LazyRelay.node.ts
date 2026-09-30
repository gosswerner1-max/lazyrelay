import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';

import {
	type ApiOptions,
	REVIEW_LINK_PAGE,
	buildMultipartBody,
	lazyRelayApiRequest,
	splitList,
} from './GenericFunctions';
import {
	accountProperties,
	analyticsProperties,
	mediaProperties,
	platformRulesProperties,
	postProperties,
	postingSlotProperties,
	reviewLinkProperties,
} from './descriptions';

/** Turns the "Additional Fields" collection into the field names the LazyRelay API expects. */
export function buildPostFields(
	node: ReturnType<IExecuteFunctions['getNode']>,
	fields: IDataObject,
): IDataObject {
	const body: IDataObject = {};
	const text = (key: string) => {
		const value = fields[key];
		if (typeof value === 'string' && value !== '') body[key] = value;
	};
	text('mediaUrl');
	text('content');
	text('coverImageUrl');
	text('mediaAltText');
	text('firstComment');
	text('selfReplyText');
	text('boardId');
	text('destinationLink');
	text('tiktokPrivacyLevel');

	const mediaUrls = splitList(fields.mediaUrls);
	if (mediaUrls.length > 0) body.mediaUrls = mediaUrls;
	const tags = splitList(fields.tags);
	if (tags.length > 0) body.tags = tags;

	if (fields.selfReplyAtLikes !== undefined && fields.selfReplyAtLikes !== '') {
		body.selfReplyAtLikes = Number(fields.selfReplyAtLikes);
	}
	for (const key of [
		'tiktokDisableComment',
		'tiktokDisableDuet',
		'tiktokDisableStitch',
		'tiktokBrandOrganic',
		'tiktokBrandContent',
	]) {
		if (typeof fields[key] === 'boolean') body[key] = fields[key];
	}

	const options = fields.options;
	if (options !== undefined && options !== '') {
		let parsed: unknown = options;
		if (typeof options === 'string') {
			try {
				parsed = JSON.parse(options);
			} catch {
				throw new NodeOperationError(node, 'Platform Options (JSON) is not valid JSON');
			}
		}
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new NodeOperationError(node, 'Platform Options (JSON) must be a JSON object');
		}
		if (Object.keys(parsed as IDataObject).length > 0) body.options = parsed as IDataObject;
	}
	return body;
}

/** LazyRelay wants ISO 8601 with a zone. */
function toIsoDate(node: ReturnType<IExecuteFunctions['getNode']>, value: unknown): string {
	const date = new Date(String(value));
	if (Number.isNaN(date.getTime())) {
		throw new NodeOperationError(node, `Scheduled For is not a valid date: ${String(value)}`);
	}
	return date.toISOString();
}

const enc = encodeURIComponent;

export class LazyRelay implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'LazyRelay',
		name: 'lazyRelay',
		icon: { light: 'file:lazyrelay.svg', dark: 'file:lazyrelay.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Schedule and publish social posts, and manage drafts, media, analytics and client review links in LazyRelay',
		defaults: { name: 'LazyRelay' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'lazyRelayApi', required: true }],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Account', value: 'account' },
					{ name: 'Analytics', value: 'analytics' },
					{ name: 'Client Review Link', value: 'reviewLink' },
					{ name: 'Media', value: 'media' },
					{ name: 'Platform Rules', value: 'platformRules' },
					{ name: 'Post', value: 'post' },
					{ name: 'Posting Slot', value: 'postingSlot' },
				],
				default: 'post',
			},
			...postProperties,
			...accountProperties,
			...platformRulesProperties,
			...mediaProperties,
			...postingSlotProperties,
			...analyticsProperties,
			...reviewLinkProperties,
		],
	};

	methods = {
		loadOptions: {
			async getSocialAccounts(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const accounts = (await lazyRelayApiRequest.call(this, 'GET', '/social-accounts')) as IDataObject[];
				return (Array.isArray(accounts) ? accounts : []).map((account) => {
					const platform = String(account.platform ?? 'account');
					const name = String(account.display_name ?? account.platform_account_id ?? account.id);
					const reconnect = account.needs_reconnect_at ? ' (needs reconnecting)' : '';
					return {
						name: `${platform}: ${name}${reconnect}`,
						value: String(account.id),
						description: account.brand_label ? `Brand: ${String(account.brand_label)}` : undefined,
					};
				});
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;

		for (let i = 0; i < items.length; i++) {
			try {
				const result = await runOperation.call(this, resource, operation, i);
				const list = Array.isArray(result) ? result : [result];
				for (const entry of list) {
					returnData.push({
						json: (entry ?? {}) as IDataObject,
						pairedItem: { item: i },
					});
				}
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				const known = error instanceof NodeApiError || error instanceof NodeOperationError;
				throw known ? error : new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}
		return [returnData];
	}
}

/** Returns one object, or an array when the operation lists things (each becomes its own item). */
async function runOperation(
	this: IExecuteFunctions,
	resource: string,
	operation: string,
	i: number,
): Promise<unknown> {
	const node = this.getNode();
	const param = <T = string>(name: string, fallback?: unknown) =>
		this.getNodeParameter(name, i, fallback) as T;
	const call = (
		method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
		path: string,
		options?: ApiOptions,
	) => lazyRelayApiRequest.call(this, method, path, options);

	if (resource === 'post') {
		switch (operation) {
			case 'schedule': {
				const body: IDataObject = {
					socialAccountId: param('socialAccountId'),
					content: param('content'),
					scheduledFor: toIsoDate(node, param('scheduledFor')),
					...buildPostFields(node, { mediaUrl: param('mediaUrl', ''), ...param<IDataObject>('additionalFields', {}) }),
				};
				if (param<boolean>('requiresApproval', false)) body.requiresApproval = true;
				return call('POST', '/scheduled-posts', { body });
			}
			case 'publishNow': {
				const body: IDataObject = {
					socialAccountId: param('socialAccountId'),
					content: param('content'),
					...buildPostFields(node, { mediaUrl: param('mediaUrl', ''), ...param<IDataObject>('additionalFields', {}) }),
					scheduledFor: new Date().toISOString(),
				};
				return call('POST', '/scheduled-posts', { body });
			}
			case 'createDraft': {
				const body: IDataObject = {
					content: param('content'),
					...buildPostFields(node, { mediaUrl: param('mediaUrl', ''), ...param<IDataObject>('additionalFields', {}) }),
				};
				return call('POST', '/scheduled-posts/draft', { body });
			}
			case 'scheduleDraft': {
				const body: IDataObject = {
					socialAccountId: param('socialAccountId'),
					content: param('content'),
					scheduledFor: toIsoDate(node, param('scheduledFor')),
					...buildPostFields(node, { mediaUrl: param('mediaUrl', ''), ...param<IDataObject>('additionalFields', {}) }),
				};
				if (param<boolean>('requiresApproval', false)) body.requiresApproval = true;
				return call('PATCH', `/scheduled-posts/${enc(param('postId'))}/schedule`, { body });
			}
			case 'update': {
				const body = buildPostFields(node, param<IDataObject>('updateFields', {}));
				if (Object.keys(body).length === 0) {
					throw new NodeOperationError(node, 'Add at least one field to update', { itemIndex: i });
				}
				return call('PATCH', `/scheduled-posts/${enc(param('postId'))}`, { body });
			}
			case 'delete': {
				await call('DELETE', `/scheduled-posts/${enc(param('postId'))}`);
				return { success: true, id: param('postId') };
			}
			case 'approve':
				return call('PATCH', `/scheduled-posts/${enc(param('postId'))}/approve`);
			case 'getProofLink':
				return call('GET', `/scheduled-posts/${enc(param('postId'))}/proof-link`);
			case 'getAll': {
				const filters = param<IDataObject>('filters', {});
				const qs: IDataObject = {};
				if (filters.brand) qs.brand = filters.brand;
				const all = (await call('GET', '/scheduled-posts', { qs })) as IDataObject[];
				let posts = Array.isArray(all) ? all : [];
				if (filters.status) posts = posts.filter((p) => p.status === filters.status);
				if (filters.socialAccountId) {
					posts = posts.filter((p) => p.social_account_id === filters.socialAccountId);
				}
				if (!param<boolean>('returnAll', false)) posts = posts.slice(0, param<number>('limit', 50));
				return posts;
			}
		}
	}

	if (resource === 'account' && operation === 'getAll') {
		return call('GET', '/social-accounts');
	}

	if (resource === 'platformRules' && operation === 'get') {
		const platform = param('platform', '').trim();
		return call('GET', '/platforms/rules', { qs: platform ? { platform } : {} });
	}

	if (resource === 'media' && operation === 'upload') {
		const propertyName = param('binaryPropertyName', 'data');
		const binary = this.getInputData()[i].binary?.[propertyName];
		if (!binary) {
			throw new NodeOperationError(node, `No binary data found in field "${propertyName}"`, {
				itemIndex: i,
			});
		}
		const buffer = await this.helpers.getBinaryDataBuffer(i, propertyName);
		const altText = param('altText', '');
		const multipart = buildMultipartBody(
			{
				field: 'file',
				buffer,
				fileName: binary.fileName ?? 'upload',
				mimeType: binary.mimeType || 'application/octet-stream',
			},
			altText ? { altText } : {},
		);
		return call('POST', '/media/upload', {
			body: multipart.body,
			headers: { 'Content-Type': multipart.contentType },
		});
	}

	if (resource === 'postingSlot' && operation === 'getNextFree') {
		return call('GET', '/posting-slots/next', { qs: { socialAccountId: param('socialAccountId') } });
	}

	if (resource === 'analytics' && operation === 'getSummary') {
		const filters = param<IDataObject>('filters', {});
		const qs: IDataObject = { days: param<number>('days', 30) };
		if (filters.brand) qs.brand = filters.brand;
		if (filters.tag) qs.tag = filters.tag;
		return call('GET', '/analytics/summary', { qs });
	}

	if (resource === 'reviewLink') {
		if (operation === 'create') {
			const fields = param<IDataObject>('additionalFields', {});
			const body: IDataObject = {};
			if (fields.label) body.label = fields.label;
			if (fields.brandLabel) body.brandLabel = fields.brandLabel;
			if (fields.expiresInDays !== undefined) body.expiresInDays = Number(fields.expiresInDays);
			const link = (await call('POST', '/review-links', { body })) as IDataObject;
			return { ...link, url: `${REVIEW_LINK_PAGE}${String(link.token)}` };
		}
		if (operation === 'getAll') {
			const response = (await call('GET', '/review-links')) as IDataObject;
			const links = Array.isArray(response.links) ? (response.links as IDataObject[]) : [];
			return links.map((link) => ({ ...link, url: `${REVIEW_LINK_PAGE}${String(link.token)}` }));
		}
		if (operation === 'revoke') {
			return call('DELETE', `/review-links/${enc(param('linkId'))}`);
		}
	}

	throw new NodeOperationError(node, `The operation "${operation}" is not supported for "${resource}"`, {
		itemIndex: i,
	});
}
