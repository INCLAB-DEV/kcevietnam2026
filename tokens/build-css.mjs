#!/usr/bin/env node
/**
 * NABI token build — JSON (single source) → docs/prototypes/nabi-ui.css
 * ---------------------------------------------------------------------
 * Strategy: SURGICAL VALUE SYNC, not regeneration.
 *   For every token that carries a CSS name (com.nabi.css), we resolve its
 *   CSS value and replace ONLY the value of that declaration in nabi-ui.css.
 *   All hand-written comments, structure, base reset, chrome components, and
 *   the back-compat alias section are preserved untouched.
 *
 * Resolution rules (reproduce existing nabi-ui.css exactly):
 *   · color aliasing a PRIMITIVE  → literal hex
 *   · color aliasing a SEMANTIC   → var(--that-css-name)  (indirection)
 *   · dimension                   → px value verbatim
 *   · duration                    → seconds (150ms → 0.15s)
 *   · cubicBezier                 → cubic-bezier(a, b, c, d)
 *   · fontFamily                  → com.nabi.cssValue (full fallback stack)
 *
 * Usage:  node tokens/build-css.mjs            # write
 *         node tokens/build-css.mjs --check    # verify in sync (CI), no write
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO = join(ROOT, '..');
const CSS_PATH = join(REPO, 'docs/prototypes/nabi-ui.css');
const CHECK = process.argv.includes('--check');

const EXT_CSS = 'com.nabi.css';
const EXT_CSSVALUE = 'com.nabi.cssValue';

// ── Load every *.tokens.json under tokens/{primitive,semantic} ──
function loadTokens(dir) {
  const out = {};
  for (const f of readdirSync(join(ROOT, dir))) {
    if (!f.endsWith('.tokens.json')) continue;
    Object.assign(out, JSON.parse(readFileSync(join(ROOT, dir, f), 'utf8')));
  }
  return out;
}
const primitives = loadTokens('primitive');
const semantics = loadTokens('semantic');

// ── Flatten into a path → token map; remember which tier each token is in ──
const byPath = new Map();   // "color.blue.600" → { token, tier }
function walk(node, path, tier) {
  if (node && typeof node === 'object' && '$value' in node) {
    byPath.set(path.join('.'), { token: node, tier });
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith('$')) continue;
      walk(v, [...path, k], tier);
    }
  }
}
walk(primitives, [], 'primitive');
walk(semantics, [], 'semantic');

const refPath = (v) => (typeof v === 'string' && v.startsWith('{') && v.endsWith('}')) ? v.slice(1, -1) : null;
const cssNameOf = (entry) => entry?.token?.$extensions?.[EXT_CSS] || null;

function resolveCssValue(entry) {
  const { token } = entry;
  const ext = token.$extensions || {};
  if (ext[EXT_CSSVALUE]) return ext[EXT_CSSVALUE];          // fontFamily etc.

  switch (token.$type) {
    case 'color': {
      const rp = refPath(token.$value);
      if (!rp) return String(token.$value).toLowerCase();   // literal hex
      const target = byPath.get(rp);
      if (!target) throw new Error(`unresolved reference {${rp}}`);
      if (target.tier === 'primitive') return resolveCssValue(target); // inline literal
      return `var(${cssNameOf(target)})`;                   // semantic → indirection
    }
    case 'dimension': return String(token.$value);
    case 'duration': {
      const ms = parseFloat(String(token.$value));
      return `${ms / 1000}s`;                                // 150ms → 0.15s
    }
    case 'cubicBezier': return `cubic-bezier(${token.$value.join(', ')})`;
    default: return String(token.$value);
  }
}

// ── Build cssName → value map ──
const updates = new Map();
for (const entry of byPath.values()) {
  const name = cssNameOf(entry);
  if (!name) continue;
  updates.set(name, resolveCssValue(entry));
}

// ── Surgical replace in nabi-ui.css ──
let css = readFileSync(CSS_PATH, 'utf8');
const original = css;
const missing = [];
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

for (const [name, value] of updates) {
  // match the DECLARATION:  --name : <value> ;   (literal colon guards prefix collisions)
  const re = new RegExp(`(${escape(name)}\\s*:\\s*)([^;]+)(;)`);
  if (!re.test(css)) { missing.push(name); continue; }
  css = css.replace(re, (_, pre, _old, semi) => `${pre}${value}${semi}`);
}

if (missing.length) {
  console.error(`⚠ ${missing.length} token(s) have no matching declaration in nabi-ui.css:`);
  for (const m of missing) console.error(`   ${m}`);
}

const changed = css !== original;
if (CHECK) {
  if (changed) {
    console.error('✖ nabi-ui.css is OUT OF SYNC with tokens/. Run `node tokens/build-css.mjs`.');
    process.exit(1);
  }
  console.log('✓ nabi-ui.css is in sync with tokens/.');
  process.exit(0);
}

if (changed) {
  writeFileSync(CSS_PATH, css);
  console.log(`✓ synced ${updates.size} tokens → docs/prototypes/nabi-ui.css`);
} else {
  console.log(`✓ already in sync (${updates.size} tokens, no changes)`);
}
if (missing.length) process.exit(1);
