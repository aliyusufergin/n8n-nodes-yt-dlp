import { configWithoutCloudSupport } from '@n8n/node-cli/eslint';

export default [
	...configWithoutCloudSupport,
	{
		files: ['package.json'],
		rules: {
			'@n8n/community-nodes/no-runtime-dependencies': 'off',
		},
	},
	{
		files: ['nodes/YtDlp/YtDlp.node.ts'],
		rules: {
			'@n8n/community-nodes/node-usable-as-tool': 'off',
			'@n8n/community-nodes/require-continue-on-fail': 'off',
			'n8n-nodes-base/node-class-description-credentials-name-unsuffixed': 'off',
		},
	},
	{
		files: ['credentials/YtDlpAuthentication.credentials.ts'],
		rules: {
			'@n8n/community-nodes/cred-class-name-field-conventions': 'off',
			'@n8n/community-nodes/cred-class-name-suffix': 'off',
			'@n8n/community-nodes/credential-test-required': 'off',
			'n8n-nodes-base/cred-class-field-display-name-missing-api': 'off',
			'n8n-nodes-base/cred-class-field-name-unsuffixed': 'off',
			'n8n-nodes-base/cred-class-name-unsuffixed': 'off',
		},
	},
	{
		files: ['nodes/YtDlp/authentication.ts'],
		rules: {
			'@n8n/community-nodes/require-node-api-error': 'off',
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
		files: ['nodes/YtDlp/process.ts', 'test/platform-packages.test.ts'],
		rules: {
			'@n8n/community-nodes/no-dangerous-functions': 'off',
		},
	},
];
