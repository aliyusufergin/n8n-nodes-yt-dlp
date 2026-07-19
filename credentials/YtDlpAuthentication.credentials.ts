import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class YtDlpAuthentication implements ICredentialType {
	name = 'ytDlpAuthentication';

	displayName = 'YT-DLP Authentication';

	documentationUrl = 'https://github.com/aliyusufergin/n8n-nodes-yt-dlp';

	icon = 'file:../nodes/YtDlp/yt-dlp.svg' as const;

	restrictToSupportedNodes = true as const;

	supportedNodes = ['ytDlp'];

	properties: INodeProperties[] = [
		{
			displayName: 'Netscape Cookie Content',
			name: 'cookies',
			type: 'string',
			typeOptions: { password: true, rows: 8 },
			default: '',
			description: 'Contents of a Netscape-format cookie file',
		},
		{
			displayName: 'Site Username',
			name: 'username',
			type: 'string',
			typeOptions: { password: true },
			default: '',
		},
		{
			displayName: 'Site Password',
			name: 'password',
			type: 'string',
			typeOptions: { password: true },
			default: '',
		},
		{
			displayName: 'Video Password',
			name: 'videoPassword',
			type: 'string',
			typeOptions: { password: true },
			default: '',
		},
		{
			displayName: 'Authenticated Proxy URL',
			name: 'proxyUrl',
			type: 'string',
			typeOptions: { password: true },
			default: '',
		},
	];
}
