import { fileURLToPath } from 'node:url';

const backend = Bun.spawn(
  ['uv', 'run', '--locked', 'uvicorn', 'backend.submissions:create_app', '--factory', '--host', '127.0.0.1', '--port', '8000'],
  { cwd: fileURLToPath(new URL('../backend/', import.meta.url)), stdout: 'inherit', stderr: 'inherit' },
);
// Keep Astro attached so this command can stop both children together.
const astroCli = fileURLToPath(new URL('./node_modules/astro/bin/astro.mjs', import.meta.url));
const frontend = Bun.spawn(
  ['node', astroCli, 'dev', '--ignore-lock', ...process.argv.slice(2)],
  { stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' },
);

function stop() {
  frontend.kill();
  backend.kill();
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
const exitCode = await Promise.race([backend.exited, frontend.exited]);
stop();
await Promise.all([backend.exited, frontend.exited]);
process.exitCode = exitCode;
