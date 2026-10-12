// Shared build helpers for `npm run build` and `npm run dev`.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';

const require = createRequire(import.meta.url);
export const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const clientSrc = path.join(root, 'client/src');
const outClient = path.join(root, 'dist/client');

function walk(dir, exts, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, exts, out);
    else if (exts.some((x) => p.endsWith(x))) out.push(p);
  }
  return out;
}

/** Compile Tailwind v4 using its JS API: we extract candidate tokens from source files ourselves. */
export async function buildCss({ minify }) {
  const twDir = path.dirname(require.resolve('tailwindcss/package.json'));
  const { compile } = await import(path.join(twDir, 'dist/lib.mjs'));
  const entry = path.join(clientSrc, 'styles.css');
  const compiler = await compile(fs.readFileSync(entry, 'utf8'), {
    base: path.dirname(entry),
    loadStylesheet: async (id, base) => {
      const p = id === 'tailwindcss' ? path.join(twDir, 'index.css') : id.startsWith('tailwindcss/') ? path.join(twDir, id.slice(12)) : path.resolve(base, id);
      return { path: p, base: path.dirname(p), content: fs.readFileSync(p, 'utf8') };
    },
    loadModule: async () => { throw new Error('Tailwind JS plugins are not supported in this build'); },
  });
  const candidates = new Set();
  for (const f of walk(path.join(root, 'client/src'), ['.ts', '.tsx'])) {
    for (const tok of fs.readFileSync(f, 'utf8').split(/[\s"'`{}();,]+/)) if (tok && tok.length < 120) candidates.add(tok);
  }
  let css = compiler.build([...candidates]);
  if (minify) css = (await esbuild.transform(css, { loader: 'css', minify: true })).code;
  return css;
}

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 10);

export function clientBuildOptions({ dev }) {
  return {
    entryPoints: { app: path.join(clientSrc, 'main.tsx') },
    bundle: true,
    outdir: path.join(outClient, 'assets'),
    entryNames: dev ? '[name]' : '[name]-[hash]',
    format: 'esm',
    platform: 'browser',
    target: ['es2022', 'chrome110', 'firefox115', 'safari16'],
    jsx: 'automatic',
    minify: !dev,
    sourcemap: dev ? 'linked' : false,
    metafile: true,
    define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production') },
    logLevel: 'warning',
  };
}

export async function writeClientShell(result, { dev }) {
  const jsOut = Object.keys(result.metafile.outputs).find((o) => /app(-[A-Za-z0-9]+)?\.js$/.test(o));
  const jsName = path.basename(jsOut);
  const css = await buildCss({ minify: !dev });
  const cssName = dev ? 'app.css' : `app-${hash(css)}.css`;
  fs.mkdirSync(path.join(outClient, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(outClient, 'assets', cssName), css);
  // public/ → dist/client/
  const pub = path.join(root, 'client/public');
  for (const f of walk(pub, [''])) {
    const dest = path.join(outClient, path.relative(pub, f));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(f, dest);
  }
  const html = fs.readFileSync(path.join(root, 'client/index.html'), 'utf8')
    .replace('%CSS%', `/assets/${cssName}`)
    .replace('%JS%', `/assets/${jsName}`);
  fs.writeFileSync(path.join(outClient, 'index.html'), html);
  return { jsName, cssName };
}

export async function buildClient({ dev = false } = {}) {
  fs.rmSync(path.join(outClient, 'assets'), { recursive: true, force: true });
  const result = await esbuild.build(clientBuildOptions({ dev }));
  return writeClientShell(result, { dev });
}

export async function buildServer() {
  const out = path.join(root, 'dist');
  await esbuild.build({
    entryPoints: [path.join(root, 'server/index.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: path.join(out, 'server.js'),
    packages: 'external',
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    logLevel: 'warning',
  });
  const migSrc = path.join(root, 'server/db/migrations');
  const migOut = path.join(out, 'migrations');
  fs.mkdirSync(migOut, { recursive: true });
  for (const f of fs.readdirSync(migSrc)) fs.copyFileSync(path.join(migSrc, f), path.join(migOut, f));
}
