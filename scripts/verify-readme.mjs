#!/usr/bin/env node
// Anti-drift gate for the profile README.
//
// The page claims that every engine keeps a source of truth and that a
// verify step breaks the build when the prose disagrees. This is that step,
// for the page itself. Zero dependencies, Node built-ins only, like the
// engines it advertises.
//
//   node scripts/verify-readme.mjs
//
// Exit 0 when every check passes, 1 otherwise.

import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const README = join(ROOT, 'README.md');
const ASSETS = join(ROOT, 'assets');

/** Repos that must NOT be linked until they actually exist on GitHub. */
const UNPUBLISHED = ['Nizoka/pkinative', 'Nizoka/pkinative-cli', 'Nizoka/pkinative-mcp'];

/**
 * Domains named in the footer as "soon". Registered and parked is not shipped:
 * they stay unlinked until they serve the site over HTTPS. This check never
 * fails the build — it only says when one becomes linkable.
 */
const PENDING_DOMAINS = ['https://pkinative.dev'];

const results = [];
const pass = (name, detail = '') => results.push({ ok: true, name, detail });
const fail = (name, detail) => results.push({ ok: false, name, detail });

// ── helpers ──────────────────────────────────────────────────────────────────

/** GET with retries — an external link check must not fail the build on a blip. */
async function probe(url, { attempts = 3 } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(20_000),
        headers: { 'user-agent': 'nizoka-profile-verify' },
      });
      if (res.ok) return { ok: true, status: res.status };
      last = { ok: false, status: res.status };
    } catch (err) {
      last = { ok: false, status: err.name === 'TimeoutError' ? 'timeout' : err.message };
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  return last;
}

const relLuminance = (hex) => {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};

const contrast = (fg, bg) => {
  const [hi, lo] = [relLuminance(fg), relLuminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
};

// ── checks ───────────────────────────────────────────────────────────────────

const readme = await readFile(README, 'utf8');

// 1. Conversion invariants — the page must still tell a visitor what to run.
{
  const hasInstall = /```bash\n[\s\S]*?npm install /.test(readme);
  const hasSnippet = /```ts\n[\s\S]*?import /.test(readme);
  hasInstall
    ? pass('README has an install command')
    : fail('README has an install command', 'no `npm install` inside a bash fence');
  hasSnippet
    ? pass('README has an API snippet')
    : fail('README has an API snippet', 'no `import` inside a ts fence');
}

// 2. No link to a repo that does not exist yet.
{
  for (const repo of UNPUBLISHED) {
    const linked = readme.includes(`github.com/${repo}`);
    const live = (await probe(`https://api.github.com/repos/${repo}`)).ok;
    if (linked && !live) fail(`${repo} not linked while absent`, 'README links a repo that 404s');
    else if (!linked && live) pass(`${repo} now exists`, 'it may be linked — update the README');
    else pass(`${repo} link state consistent`, linked ? 'linked and live' : 'absent and unlinked');
  }
}

// 2b. Domains marked "soon" must stay unlinked until HTTPS actually serves.
{
  for (const url of PENDING_DOMAINS) {
    const host = new URL(url).host;
    const linked = readme.includes(`](${url}`) || readme.includes(`href="${url}`);
    const live = (await probe(url, { attempts: 1 })).ok;
    if (linked && !live) fail(`${host} linked but not serving`, 'remove the link or ship the site');
    else if (!linked && live) pass(`${host} is live`, 'HTTPS answers — it can be linked now');
    else pass(`${host} pending`, linked ? 'linked and live' : 'parked, correctly unlinked');
  }
}

// 3. Every outbound link resolves.
{
  const urls = [...new Set([...readme.matchAll(/https?:\/\/[^\s)"'<>]+/g)].map((m) => m[0]))]
    .filter((u) => !u.includes('img.shields.io')) // badges checked via the registry below
    .filter((u) => !u.includes('npmjs.com')); //    npm's web pages 403 CI agents
  for (const url of urls) {
    const r = await probe(url);
    r.ok ? pass(`link ${url}`) : fail(`link ${url}`, `status ${r.status}`);
  }
}

// 4. Every badge points at a package that is really on the registry.
{
  const pkgs = [...new Set([...readme.matchAll(/img\.shields\.io\/npm\/v\/([^?]+)\?/g)].map((m) => m[1]))];
  if (!pkgs.length) fail('badges present', 'no npm version badge found');
  for (const pkg of pkgs) {
    const r = await probe(`https://registry.npmjs.org/${pkg}/latest`);
    r.ok ? pass(`npm ${pkg}`) : fail(`npm ${pkg}`, `registry returned ${r.status}`);
  }
}

// 5. Banners: well-formed, and every text colour passes WCAG AA.
{
  for (const file of (await readdir(ASSETS)).filter((f) => f.endsWith('.svg'))) {
    const svg = await readFile(join(ASSETS, file), 'utf8');

    const open = (svg.match(/<(?!\/|!|\?)[a-zA-Z]+/g) || []).length;
    const selfClose = (svg.match(/\/>/g) || []).length;
    const close = (svg.match(/<\/[a-zA-Z]+>/g) || []).length;
    open === selfClose + close
      ? pass(`${file} well-formed`)
      : fail(`${file} well-formed`, `${open} open vs ${selfClose} self-closing + ${close} closing`);

    const bg = svg.match(/<rect[^>]*\bwidth="1200"[^>]*fill="(#[0-9a-fA-F]{6})"/)?.[1];
    if (!bg) {
      fail(`${file} background`, 'no full-canvas <rect> with a hex fill');
      continue;
    }
    const texts = [...svg.matchAll(/<text[^>]*fill="(#[0-9a-fA-F]{6})"[^>]*>([^<]*)</g)];
    if (!texts.length) fail(`${file} text colours`, 'no <text> with an explicit fill');
    for (const [, fg, label] of texts) {
      const ratio = contrast(fg, bg);
      ratio >= 4.5
        ? pass(`${file} ${fg} on ${bg}`, `${ratio.toFixed(2)} — "${label.trim()}"`)
        : fail(`${file} ${fg} on ${bg}`, `${ratio.toFixed(2)} < 4.5 (AA) — "${label.trim()}"`);
    }
  }
}

// ── report ───────────────────────────────────────────────────────────────────

const failures = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
}
console.log(`\n${results.length - failures.length}/${results.length} checks passed`);

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:`);
  for (const f of failures) console.error(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
