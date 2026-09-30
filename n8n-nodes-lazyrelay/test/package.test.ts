import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const req = createRequire(join(root, 'package.json'));

describe('package.json n8n block', () => {
	beforeAll(() => {
		execSync('npm run build', { cwd: root, stdio: 'pipe' });
	});

	it('follows the community package conventions', () => {
		expect(pkg.name).toBe('n8n-nodes-lazyrelay');
		expect(pkg.keywords).toContain('n8n-community-node-package');
		expect(pkg.n8n.n8nNodesApiVersion).toBe(1);
		expect(pkg.peerDependencies['n8n-workflow']).toBeDefined();
		expect(pkg.dependencies).toBeUndefined();
	});

	it('points at built files that exist, load, and have their icons next to them', () => {
		const nodes: string[] = pkg.n8n.nodes;
		const creds: string[] = pkg.n8n.credentials;
		expect(nodes.length + creds.length).toBe(3);
		for (const f of [...creds, ...nodes]) expect(existsSync(join(root, f)), f).toBe(true);

		for (const f of nodes) {
			const mod = req(join(root, f)) as Record<string, new () => { description: { icon: unknown } }>;
			const Cls = Object.values(mod).find((v) => typeof v === 'function')!;
			const icon = new Cls().description.icon as string | { light: string; dark: string };
			const icons = typeof icon === 'string' ? [icon] : [icon.light, icon.dark];
			for (const i of icons) {
				expect(existsSync(join(dirname(join(root, f)), i.replace('file:', ''))), i).toBe(true);
			}
		}
		for (const f of creds) {
			const mod = req(join(root, f)) as Record<string, new () => { icon: string }>;
			const cred = new (Object.values(mod)[0])();
			expect(existsSync(join(dirname(join(root, f)), cred.icon.replace('file:', '')))).toBe(true);
		}
	});
});
