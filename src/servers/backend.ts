import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

import { log, logChild } from '../logger';
import type { AppPaths } from '../paths';
import type { DesktopConfig } from '../config';

export interface BackendOptions {
	databaseUrl: string;
	config: DesktopConfig;
}

/**
 * Starts the NestJS backend as plain Node (`ELECTRON_RUN_AS_NODE`) serving the
 * API *and* the SPA on a single origin (plan §5.3 step 4 — ServeStaticModule
 * inside the backend, so there is no separate frontend server).
 */
export function startBackend(paths: AppPaths, options: BackendOptions): ChildProcess {
	const { config } = options;
	const origin = `http://127.0.0.1:${config.httpPort}`;

	const env: NodeJS.ProcessEnv = {
		...process.env,
		ELECTRON_RUN_AS_NODE: '1',
		NODE_ENV: 'production',
		// Loopback only: the desktop API must not be reachable from the LAN.
		HOST: '127.0.0.1',
		PORT: String(config.httpPort),
		COMPUTE_ADDR: `127.0.0.1:${config.grpcPort}`,
		COMPUTE_PROTO_PATH: paths.protoPath,
		DATABASE_URL: options.databaseUrl,
		// Single-origin mode: the backend serves the built SPA itself.
		SERVE_STATIC_DIR: paths.frontendDir,
		// No Redis in a desktop install (plan §5.5).
		REDIS_ENABLED: 'false',
		FRONTEND_URL: origin,
		CORS_ORIGINS: origin,
		// Cookie flags for plain-HTTP loopback. Both are set to the empty
		// string on purpose: `z.coerce.boolean()` turns *any* non-empty string
		// — including `'false'` — into `true` (which would break the refresh
		// cookie over http://), and an explicit value stops a dev `.env` or a
		// stray shell variable from leaking in (dotenv never overrides keys
		// that are already present). Empty domain = host-only cookie.
		COOKIE_SECURE: '',
		COOKIE_DOMAIN: '',
		...config.secrets,
	};

	const child = spawn(process.execPath, [path.join(paths.backendDir, 'dist', 'main.js')], {
		cwd: paths.backendDir,
		env,
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});

	child.stdout?.on('data', (chunk: Buffer) => logChild('backend', chunk));
	child.stderr?.on('data', (chunk: Buffer) => logChild('backend', chunk));
	child.on('error', (error) => log(`[backend] failed to spawn: ${error.message}`));
	child.on('exit', (code, signal) => log(`[backend] exited (code=${code}, signal=${signal})`));

	log(`backend started (pid=${child.pid}) on ${origin}`);
	return child;
}
