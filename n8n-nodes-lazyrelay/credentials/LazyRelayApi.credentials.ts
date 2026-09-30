import type { IAuthenticateGeneric, ICredentialTestRequest, ICredentialType, INodeProperties } from 'n8n-workflow';

export class LazyRelayApi implements ICredentialType {
	name = 'lazyRelayApi';

	displayName = 'LazyRelay API';

	icon = 'file:lazyrelay.svg' as const;

	documentationUrl = 'https://lazyrelay.com';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'Create an API key in the LazyRelay dashboard. It starts with lzr_live_',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://lazyrelaylazyrelay-backend.onrender.com/api',
			description: 'Only change this if LazyRelay gave you a different API address',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/social-accounts',
			method: 'GET',
		},
	};
}
