import { configWithoutCloudSupport } from '@n8n/node-cli/eslint';

export default [
  ...configWithoutCloudSupport,
  {
    files: [
      'nodes/YtDlp/invocation-runtime.ts',
      'nodes/YtDlp/node-execution.ts',
      'nodes/YtDlp/platform-resolver.ts',
    ],
    rules: {
      '@n8n/community-nodes/require-node-api-error': 'off',
    },
  },
  {
    files: ['nodes/YtDlp/invocation-runtime.ts'],
    rules: {
      '@n8n/community-nodes/no-dangerous-functions': 'off',
    },
  },
  {
    files: ['nodes/YtDlp/YtDlp.node.ts'],
    rules: {
      '@n8n/community-nodes/node-usable-as-tool': 'off',
      '@n8n/community-nodes/require-node-api-error': 'off',
      'n8n-nodes-base/node-class-description-credentials-name-unsuffixed': 'off',
    },
  },
  {
    files: ['credentials/YtDlpSecrets.credentials.ts'],
    rules: {
      '@n8n/community-nodes/credential-test-required': 'off',
      '@n8n/community-nodes/cred-class-name-field-conventions': 'off',
      '@n8n/community-nodes/cred-class-name-suffix': 'off',
      'n8n-nodes-base/cred-class-field-display-name-miscased': 'off',
      'n8n-nodes-base/cred-class-field-display-name-missing-api': 'off',
      'n8n-nodes-base/cred-class-field-name-unsuffixed': 'off',
      'n8n-nodes-base/cred-class-name-unsuffixed': 'off',
    },
  },
];
