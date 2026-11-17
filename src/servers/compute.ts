import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

import { log, logChild } from '../logger';
import type { AppPaths } from '../paths';

/**
 * Starts the Rust compute service (gRPC, plan §5.3 step 2). It is bound to
 * loopback only — the desktop build never exposes the compute port on the LAN.
 */
export function startCompute(paths: AppPaths, grpcPort: number): ChildProcess {
	const child = spawn(paths.computeExe, [], {
		cwd: path.dirname(paths.computeExe),
		env: { ...process.env, COMPUTE_ADDR: `127.0.0.1:${grpcPort}` },
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});

	child.stdout?.on('data', (chunk: Buffer) => logChild('compute', chunk));
	child.stderr?.on('data', (chunk: Buffer) => logChild('compute', chunk));
	child.on('error', (error) => log(`[compute] failed to spawn: ${error.message}`));
	child.on('exit', (code, signal) => log(`[compute] exited (code=${code}, signal=${signal})`));

	log(`compute started (pid=${child.pid}) on 127.0.0.1:${grpcPort}`);
	return child;
}
