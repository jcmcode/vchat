// Deploy to Cloudflare, optionally on your own domain, without putting the domain in the repo.
//
// Put your domain in apps/cloudflare/.deploy.local (git ignores it), or pass it as an environment
// variable:
//
//   DOMAIN=call.example.com
//
// With a domain, the Worker is deployed to it as a Custom Domain and the free *.workers.dev address
// is switched off, so the app is only reachable on your domain. Without one, it deploys to
// workers.dev as usual. Extra arguments are passed to `wrangler deploy` (e.g. --dry-run).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const localFile = join(root, '.deploy.local');

function readLocal() {
  if (!existsSync(localFile)) return {};
  const out = {};
  for (const line of readFileSync(localFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trimStart().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

/** Remove // and /* *\/ comments from JSONC (outside strings). */
function stripComments(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

const domain = (process.env.DOMAIN || readLocal().DOMAIN || '').trim().toLowerCase();
const extra = process.argv.slice(2);
const wrangler = (args) => spawnSync('pnpm', ['exec', 'wrangler', ...args], { cwd: root, stdio: 'inherit' }).status ?? 1;

if (!domain) {
  process.exit(wrangler(['deploy', ...extra]));
}
if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
  console.error(`DOMAIN doesn't look like a hostname: ${domain}`);
  process.exit(1);
}

// Same configuration as wrangler.jsonc, plus your domain, in a temporary file next to it (so the
// relative paths stay valid). It's deleted afterwards and ignored by git.
const config = JSON.parse(stripComments(readFileSync(join(root, 'wrangler.jsonc'), 'utf8')).replace(/,(\s*[}\]])/g, '$1'));
delete config.$schema;
config.workers_dev = false;
config.routes = [{ pattern: domain, custom_domain: true }];
const generated = join(root, '.wrangler.deploy.json');
writeFileSync(generated, JSON.stringify(config, null, 2));
console.log(`Deploying to https://${domain} (workers.dev address off)`);
try {
  process.exitCode = wrangler(['deploy', '--config', generated, ...extra]);
} finally {
  rmSync(generated, { force: true });
}
