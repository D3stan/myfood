import { spawn } from 'node:child_process';

const server = spawn(process.execPath, ['src/server/main.ts'], { stdio: 'inherit', env: process.env });
const web = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], { stdio: 'inherit', env: process.env });
const stop = (signal = 'SIGTERM') => { server.kill(signal); web.kill(signal); };
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
server.on('exit', (code) => { if (code && code !== 0) process.exitCode = code; stop(); });
web.on('exit', (code) => { if (code && code !== 0) process.exitCode = code; stop(); });
