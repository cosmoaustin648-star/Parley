// Development: rebuild the client on change and restart the server on change.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { root, clientBuildOptions, writeClientShell } from './build-lib.mjs';

const opts = clientBuildOptions({ dev: true });
const ctx = await esbuild.context({
  ...opts,
  plugins: [{
    name: 'shell',
    setup(build) {
      build.onEnd(async (result) => {
        if (result.errors.length) return;
        try { await writeClientShell(result, { dev: true }); console.log('[dev] client rebuilt'); }
        catch (e) { console.error('[dev] css/shell failed', e); }
      });
    },
  }],
});
await ctx.watch();
// Tailwind classes can change without JS changes (e.g. styles.css); watch it too.
fs.watch(path.join(root, 'client/src/styles.css'), () => ctx.rebuild().catch(() => {}));

const server = spawn(process.execPath, ['--import', 'tsx', '--watch', '--watch-preserve-output', 'server/index.ts'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'development' },
});
const stop = () => { server.kill(); ctx.dispose(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
