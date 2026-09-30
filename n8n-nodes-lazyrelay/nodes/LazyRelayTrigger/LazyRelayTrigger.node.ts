import { createHmac, timingSafeEqual } from 'node:crypto';
import { NodeConnectionTypes } from 'n8n-workflow';
import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';

export const LAZYRELAY_EVENTS = [
	'post.verified',
	'post.failed',
	'post.unconfirmed',
	'channel.needs_reconnect',
] as const;

export const SIGNATURE_HEADER = 'x-lazyrelay-signature';

/**
 * LazyRelay signs every delivery with HMAC-SHA256 of the raw JSON body, hex encoded, using the
 * endpoint's secret. The comparison is timing-safe.
 */
export function verifySignature(
	secret: string,
	rawBody: Buffer | string,
	signature: string | string[] | undefined,
): boolean {
	const received = Array.isArray(signature) ? signature[0] : signature;
	if (!secret || typeof received !== 'string' || received === '') return false;
	const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
	const a = Buffer.from(received.trim().toLowerCase(), 'utf8');
	const b = Buffer.from(expected, 'utf8');
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

export class LazyRelayTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'LazyRelay Trigger',
		name: 'lazyRelayTrigger',
		icon: { light: 'file:lazyrelay.svg', dark: 'file:lazyrelay.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: 'Signed webhook',
		description: 'Starts a workflow when LazyRelay reports a post result or a channel problem',
		defaults: { name: 'LazyRelay Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName:
					'Setup: 1) Copy the Production URL (or the Test URL while testing) shown above. 2) In LazyRelay open Settings, then Webhooks, add an endpoint with that URL and copy the secret LazyRelay shows once. 3) Paste the secret below. LazyRelay webhooks cannot be created with an API key, so this node does not register itself.',
				name: 'setupNotice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Webhook Secret',
				name: 'webhookSecret',
				type: 'string',
				typeOptions: { password: true },
				required: true,
				default: '',
				description:
					'The secret LazyRelay showed when you created the webhook endpoint. Every delivery is checked against it and rejected with 401 if the signature does not match',
			},
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				options: [
					{
						name: 'Channel Needs Reconnect',
						value: 'channel.needs_reconnect',
						description: 'A connected account needs to be reconnected',
					},
					{
						name: 'Post Failed',
						value: 'post.failed',
						description: 'A post failed to publish',
					},
					{
						name: 'Post Unconfirmed',
						value: 'post.unconfirmed',
						description: 'A post was sent but could not be confirmed live',
					},
					{
						name: 'Post Verified',
						value: 'post.verified',
						description: 'A post was confirmed live',
					},
				],
				default: ['post.verified', 'post.failed', 'post.unconfirmed', 'channel.needs_reconnect'],
				description:
					'Only these events start the workflow, the others are answered with 200 and ignored. Leave empty to accept all events',
			},
		],
	};

	// LazyRelay endpoints are created by a person in the dashboard, so there is nothing to register
	// or clean up on activation. n8n's own webhook URL is the only thing that needs to exist.
	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				return true;
			},
			async create(this: IHookFunctions): Promise<boolean> {
				return true;
			},
			async delete(this: IHookFunctions): Promise<boolean> {
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const req = this.getRequestObject();
		const res = this.getResponseObject();
		const body = this.getBodyData();
		const headers = this.getHeaderData();

		const secret = String(this.getNodeParameter('webhookSecret', '') ?? '').trim();
		const rawBody = (req as unknown as { rawBody?: Buffer | string }).rawBody ?? JSON.stringify(body);

		if (!verifySignature(secret, rawBody, headers[SIGNATURE_HEADER])) {
			res.status(401).json({ error: 'Invalid signature' });
			return { noWebhookResponse: true };
		}

		const event = typeof body.event === 'string' ? body.event : String(headers['x-lazyrelay-event'] ?? '');
		const selected = (this.getNodeParameter('events', []) as string[]) ?? [];

		if (event === 'webhook.test' || (selected.length > 0 && !selected.includes(event))) {
			res.status(200).json({ received: true, ignored: event });
			return { noWebhookResponse: true };
		}

		return { workflowData: [[{ json: body as IDataObject }]] };
	}
}
