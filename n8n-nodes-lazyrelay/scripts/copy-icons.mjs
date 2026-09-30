// tsc does not copy non-TS files, so the SVG icons are copied next to the built nodes.
import { cpSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

for (const dir of ['nodes', 'credentials']) {
  if (!existsSync(dir)) continue;
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.svg')) cpSync(p, join('dist', p));
    }
  };
  walk(dir);
}
