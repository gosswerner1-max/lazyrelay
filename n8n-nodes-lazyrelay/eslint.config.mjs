import n8nCommunityNodes from '@n8n/eslint-plugin-community-nodes';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['dist/**', 'node_modules/**', 'test/**', 'scripts/**'] },
  {
    files: ['**/*.ts'],
    languageOptions: { parser: tseslint.parser, parserOptions: { sourceType: 'module' } },
  },
  n8nCommunityNodes.configs.recommended,
];
