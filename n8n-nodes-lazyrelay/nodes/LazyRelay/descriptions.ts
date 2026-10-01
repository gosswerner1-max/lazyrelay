import type { INodeProperties, INodePropertyOptions } from 'n8n-workflow';

export const TIKTOK_PRIVACY_LEVELS: INodePropertyOptions[] = [
	{ name: 'Public to Everyone', value: 'PUBLIC_TO_EVERYONE' },
	{ name: 'Mutual Follow Friends', value: 'MUTUAL_FOLLOW_FRIENDS' },
	{ name: 'Only Me', value: 'SELF_ONLY' },
];

export const POST_STATUSES: INodePropertyOptions[] = [
	{ name: 'Draft', value: 'draft' },
	{ name: 'Failed', value: 'failed' },
	{ name: 'Needs Approval', value: 'needs_approval' },
	{ name: 'Pending', value: 'pending' },
	{ name: 'Posted', value: 'posted' },
	{ name: 'Posting', value: 'posting' },
];

const post = (operations: string[]) => ({ resource: ['post'], operation: operations });

/** Extra post fields that every create/update operation shares. Key names match the API. */
export const additionalPostFields: INodeProperties[] = [
	{
		displayName: 'Alt Text',
		name: 'mediaAltText',
		type: 'string',
		default: '',
		description: 'Accessibility description of the main image (Mastodon and Bluesky use it)',
	},
	{
		displayName: 'Cover Image URL',
		name: 'coverImageUrl',
		type: 'string',
		default: '',
		description: 'A still cover image for a video. Pinterest video pins need one',
	},
	{
		displayName: 'Extra Image URLs',
		name: 'mediaUrls',
		type: 'string',
		default: '',
		placeholder: 'https://example.com/2.jpg, https://example.com/3.jpg',
		description: 'Comma-separated public image URLs that follow the main media, for a multi-image post',
	},
	{
		displayName: 'First Comment',
		name: 'firstComment',
		type: 'string',
		default: '',
		description: 'A comment posted right after publishing (Facebook and Instagram only)',
	},
	{
		displayName: 'First Comment Delay (Minutes)',
		name: 'firstCommentDelayMinutes',
		type: 'number',
		typeOptions: { minValue: 0, maxValue: 1440 },
		default: 0,
		description: 'Wait this many minutes after the post goes live before posting the first comment (0 to 1440, Facebook and Instagram only). 0 posts it right away.',
	},
	{
		displayName: 'Pinterest Board ID',
		name: 'boardId',
		type: 'string',
		default: '',
		description: 'Pinterest only: the board to pin to',
	},
	{
		displayName: 'Pinterest Destination Link',
		name: 'destinationLink',
		type: 'string',
		default: '',
		description: 'Pinterest only: where a click on the pin goes',
	},
	{
		displayName: 'Platform Options (JSON)',
		name: 'options',
		type: 'json',
		default: '{}',
		description:
			'Platform-specific settings, for example {"youtube":{"title":"My video","privacy":"public"}} or {"instagram":{"placement":"reel"}}. Send only the key of the platform you post to. Use the Platform Rules operation to see what each platform reads.',
	},
	{
		displayName: 'Self-Reply Like Threshold',
		name: 'selfReplyAtLikes',
		type: 'number',
		typeOptions: { minValue: 0 },
		default: 10,
		description: 'The like count that triggers the self-reply text',
	},
	{
		displayName: 'Self-Reply Text',
		name: 'selfReplyText',
		type: 'string',
		default: '',
		description:
			'A follow-up comment added once the post reaches the like threshold (Facebook and Instagram only)',
	},
	{
		displayName: 'Tags',
		name: 'tags',
		type: 'string',
		default: '',
		placeholder: 'spring-sale, launch',
		description: 'Up to 5 comma-separated labels for filtering analytics by campaign',
	},
	{
		displayName: 'TikTok Brand Content (Paid Partnership)',
		name: 'tiktokBrandContent',
		type: 'boolean',
		default: false,
		description: 'Whether the TikTok video is a paid partnership',
	},
	{
		displayName: 'TikTok Brand Organic (Own Brand)',
		name: 'tiktokBrandOrganic',
		type: 'boolean',
		default: false,
		description: "Whether the TikTok video promotes the creator's own brand",
	},
	{
		displayName: 'TikTok Disable Comments',
		name: 'tiktokDisableComment',
		type: 'boolean',
		default: true,
		description: 'Whether to turn comments off on TikTok',
	},
	{
		displayName: 'TikTok Disable Duet',
		name: 'tiktokDisableDuet',
		type: 'boolean',
		default: true,
		description: 'Whether to turn duets off on TikTok',
	},
	{
		displayName: 'TikTok Disable Stitch',
		name: 'tiktokDisableStitch',
		type: 'boolean',
		default: true,
		description: 'Whether to turn stitches off on TikTok',
	},
	{
		displayName: 'TikTok Privacy Level',
		name: 'tiktokPrivacyLevel',
		type: 'options',
		options: TIKTOK_PRIVACY_LEVELS,
		default: 'SELF_ONLY',
		description: 'TikTok only, and required for TikTok posts. The account must allow the level you pick',
	},
];

const accountField = (operations: string[], required = true): INodeProperties => ({
	displayName: 'Account Name or ID',
	name: 'socialAccountId',
	type: 'options',
	typeOptions: { loadOptionsMethod: 'getSocialAccounts' },
	default: '',
	required,
	displayOptions: { show: post(operations) },
	description:
		'The connected account to post to. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
});

export const postProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['post'] } },
		options: [
			{
				name: 'Approve',
				value: 'approve',
				action: 'Approve a post',
				description: 'Approve a post that is waiting for approval, so it gets scheduled',
			},
			{
				name: 'Create Draft',
				value: 'createDraft',
				action: 'Create a draft',
				description: 'Save a post as a draft without an account or time',
			},
			{
				name: 'Delete',
				value: 'delete',
				action: 'Delete a post',
				description: 'Cancel a pending or waiting post before it goes out',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				action: 'Get many posts',
				description: 'List upcoming and recent posts with their status',
			},
			{
				name: 'Get Proof Link',
				value: 'getProofLink',
				action: 'Get a proof link',
				description: 'A public link showing the post was confirmed live',
			},
			{
				name: 'Publish Now',
				value: 'publishNow',
				action: 'Publish a post now',
				description: 'Publish to one account right away instead of scheduling',
			},
			{
				name: 'Schedule',
				value: 'schedule',
				action: 'Schedule a post',
				description: 'Schedule a post to one connected account',
			},
			{
				name: 'Schedule Draft',
				value: 'scheduleDraft',
				action: 'Schedule a draft',
				description: 'Turn a saved draft into a scheduled post',
			},
			{
				name: 'Update',
				value: 'update',
				action: 'Update a post',
				description: 'Edit a draft, a post waiting for approval, or a pending post',
			},
		],
		default: 'schedule',
	},

	// Post ID for everything that targets an existing post
	{
		displayName: 'Post ID',
		name: 'postId',
		type: 'string',
		required: true,
		default: '',
		displayOptions: {
			show: post(['approve', 'delete', 'getProofLink', 'scheduleDraft', 'update']),
		},
		description: 'The ID of the post, from the Get Many operation',
	},

	accountField(['schedule', 'publishNow', 'scheduleDraft']),
	{
		displayName: 'Text',
		name: 'content',
		type: 'string',
		typeOptions: { rows: 4 },
		required: true,
		default: '',
		displayOptions: { show: post(['schedule', 'publishNow', 'createDraft', 'scheduleDraft']) },
		description: 'The post text or caption',
	},
	{
		displayName: 'Scheduled For',
		name: 'scheduledFor',
		type: 'dateTime',
		required: true,
		default: '',
		displayOptions: { show: post(['schedule', 'scheduleDraft']) },
		description: 'When to post. Must be in the future. Sent to LazyRelay as an ISO 8601 UTC time',
	},
	{
		displayName: 'Media URL',
		name: 'mediaUrl',
		type: 'string',
		default: '',
		displayOptions: { show: post(['schedule', 'publishNow', 'createDraft', 'scheduleDraft']) },
		description:
			'A publicly accessible image or video URL to attach. Use the Media resource to upload a file first',
	},
	{
		displayName: 'Requires Approval',
		name: 'requiresApproval',
		type: 'boolean',
		default: false,
		displayOptions: { show: post(['schedule', 'scheduleDraft']) },
		description:
			'Whether to hold the post until someone approves it (in the dashboard or through a client review link)',
	},

	// Update has its own collection because every field is optional there
	{
		displayName: 'Update Fields',
		name: 'updateFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: { show: post(['update']) },
		options: [
			{
				displayName: 'Text',
				name: 'content',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '',
				description: 'New post text',
			},
			{
				displayName: 'Media URL',
				name: 'mediaUrl',
				type: 'string',
				default: '',
				description: 'A publicly accessible image or video URL to attach',
			},
			...additionalPostFields,
		],
	},

	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: { show: post(['schedule', 'publishNow', 'createDraft', 'scheduleDraft']) },
		options: additionalPostFields,
	},

	// Get Many
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: false,
		displayOptions: { show: post(['getAll']) },
		description: 'Whether to return all results or only up to a given limit',
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		typeOptions: { minValue: 1 },
		default: 50,
		displayOptions: { show: { ...post(['getAll']), returnAll: [false] } },
		description: 'Max number of results to return',
	},
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: { show: post(['getAll']) },
		options: [
			{
				displayName: 'Account Name or ID',
				name: 'socialAccountId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getSocialAccounts' },
				default: '',
				description:
					'Only posts for this account. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Brand',
				name: 'brand',
				type: 'string',
				default: '',
				description: 'Only posts for accounts of this brand (name as shown in LazyRelay)',
			},
			{
				displayName: 'Status',
				name: 'status',
				type: 'options',
				options: POST_STATUSES,
				default: 'pending',
				description: 'Only posts with this status',
			},
		],
	},
];

export const accountProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['account'] } },
		options: [
			{
				name: 'Get Many',
				value: 'getAll',
				action: 'Get many accounts',
				description: 'List every connected social account with its platform and ID',
			},
		],
		default: 'getAll',
	},
];

export const platformRulesProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['platformRules'] } },
		options: [
			{
				name: 'Get',
				value: 'get',
				action: 'Get platform rules',
				description: "What a platform accepts: text limit, media rules, required fields and options",
			},
		],
		default: 'get',
	},
	{
		displayName: 'Platform',
		name: 'platform',
		type: 'string',
		default: '',
		placeholder: 'instagram',
		displayOptions: { show: { resource: ['platformRules'], operation: ['get'] } },
		description: 'For example instagram, tiktok, pinterest or youtube. Leave empty for all platforms',
	},
];

export const mediaProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['media'] } },
		options: [
			{
				name: 'Upload',
				value: 'upload',
				action: 'Upload a file',
				description: 'Upload an image, video or PDF from binary data and get its public URL',
			},
		],
		default: 'upload',
	},
	{
		displayName: 'Input Binary Field',
		name: 'binaryPropertyName',
		type: 'string',
		default: 'data',
		required: true,
		displayOptions: { show: { resource: ['media'], operation: ['upload'] } },
		hint: 'The name of the input binary field containing the file to upload',
	},
	{
		displayName: 'Alt Text',
		name: 'altText',
		type: 'string',
		default: '',
		displayOptions: { show: { resource: ['media'], operation: ['upload'] } },
		description: 'An optional accessibility description stored with the file (up to 1000 characters)',
	},
];

export const postingSlotProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['postingSlot'] } },
		options: [
			{
				name: 'Get Next Free Slot',
				value: 'getNextFree',
				action: 'Get the next free posting slot',
				description: "The account's next free posting time, from the times saved in Settings",
			},
		],
		default: 'getNextFree',
	},
	{
		displayName: 'Account Name or ID',
		name: 'socialAccountId',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getSocialAccounts' },
		default: '',
		required: true,
		displayOptions: { show: { resource: ['postingSlot'], operation: ['getNextFree'] } },
		description:
			'The connected account to check. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},
];

export const analyticsProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['analytics'] } },
		options: [
			{
				name: 'Get Summary',
				value: 'getSummary',
				action: 'Get an analytics summary',
				description: 'Post counts, verified-live rate, platform breakdown and engagement totals',
			},
		],
		default: 'getSummary',
	},
	{
		displayName: 'Days',
		name: 'days',
		type: 'number',
		typeOptions: { minValue: 1, maxValue: 90 },
		default: 30,
		displayOptions: { show: { resource: ['analytics'], operation: ['getSummary'] } },
		description: 'How many days back to look (1 to 90)',
	},
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: { show: { resource: ['analytics'], operation: ['getSummary'] } },
		options: [
			{
				displayName: 'Brand',
				name: 'brand',
				type: 'string',
				default: '',
				description: 'Only this brand',
			},
			{
				displayName: 'Tag',
				name: 'tag',
				type: 'string',
				default: '',
				description: 'Only posts with this tag',
			},
		],
	},
];

export const reviewLinkProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['reviewLink'] } },
		options: [
			{
				name: 'Create',
				value: 'create',
				action: 'Create a client review link',
				description: 'Create a link a client can open to approve posts, with no account needed',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				action: 'Get many client review links',
				description: 'List the client review links and their status',
			},
			{
				name: 'Revoke',
				value: 'revoke',
				action: 'Revoke a client review link',
				description: 'Stop a client review link working at once',
			},
		],
		default: 'create',
	},
	{
		displayName: 'Link ID',
		name: 'linkId',
		type: 'string',
		required: true,
		default: '',
		displayOptions: { show: { resource: ['reviewLink'], operation: ['revoke'] } },
		description: 'The ID of the link, from the Get Many operation',
	},
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: { show: { resource: ['reviewLink'], operation: ['create'] } },
		options: [
			{
				displayName: 'Brand Label',
				name: 'brandLabel',
				type: 'string',
				default: '',
				description: 'Only show posts for this brand',
			},
			{
				displayName: 'Expires In Days',
				name: 'expiresInDays',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 90 },
				default: 30,
				description: 'Days until the link stops working (1 to 90)',
			},
			{
				displayName: 'Label',
				name: 'label',
				type: 'string',
				default: '',
				description: 'Who the link is for, for example a client name',
			},
		],
	},
];
