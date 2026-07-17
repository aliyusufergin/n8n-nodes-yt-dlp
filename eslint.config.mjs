import { configWithoutCloudSupport } from '@n8n/node-cli/eslint';

export default [
	...configWithoutCloudSupport,
	{
		files: ['nodes/YtDlp/YtDlp.node.ts'],
		rules: {
			'@n8n/community-nodes/node-usable-as-tool': 'off',
			'@n8n/community-nodes/require-continue-on-fail': 'off',
		},
	},
	{
		files: ['nodes/YtDlp/source-url.ts'],
		rules: {
			'@n8n/community-nodes/require-node-api-error': 'off',
			'n8n-nodes-base/node-execute-block-wrong-error-thrown': 'off',
		},
	},
	{
		files: ['nodes/YtDlp/process.ts'],
		rules: {
			'@n8n/community-nodes/no-dangerous-functions': 'off',
		},
	},
];
