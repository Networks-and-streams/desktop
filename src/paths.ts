import path from 'node:path';
import { app } from 'electron';

/**
 * Filesystem layout of the runtime. Two modes:
 *
 * - packaged: everything the backend/compute/frontend need lives in
 *   `process.resourcesPath` (electron-builder `extraResources`, plan §5.2);
 * - dev (`electron .`): the repo layout, i.e. `<repo>/backend`, `<repo>/frontend/dist`,
 *   `<repo>/compute/target/release/compute.exe`.
 */
export interface AppPaths {
	/** Packaged extraResources root, or the repo root in dev. */
	resourcesRoot: string;
	/** Backend package: `dist/main.js`, `prisma/`, production `node_modules`. */
	backendDir: string;
	/** Built SPA (`index.html`), served by the backend via SERVE_STATIC_DIR. */
	frontendDir: string;
	/** compute.exe (Rust, gRPC). */
	computeExe: string;
	/** compute.proto, needed by the backend gRPC client. */
	protoPath: string;
	/** Per-user writable directory (config.json, pgdata). */
	userDataDir: string;
	/** Directory for main.log and child-process output. */
	logDir: string;
}

function safeLogsDir(): string {
	try {
		return app.getPath('logs');
	} catch {
		return path.join(app.getPath('userData'), 'logs');
	}
}

export function resolvePaths(): AppPaths {
	const userDataDir = app.getPath('userData');
	const logDir = safeLogsDir();

	if (app.isPackaged) {
		const root = process.resourcesPath;
		return {
			resourcesRoot: root,
			backendDir: path.join(root, 'backend'),
			frontendDir: path.join(root, 'frontend'),
			computeExe: path.join(root, 'compute.exe'),
			protoPath: path.join(root, 'proto', 'compute.proto'),
			userDataDir,
			logDir,
		};
	}

	// dev: compiled to desktop/dist/paths.js → two levels up is the repo root.
	const repoRoot = path.resolve(__dirname, '..', '..');
	return {
		resourcesRoot: repoRoot,
		backendDir: path.join(repoRoot, 'backend'),
		frontendDir: path.join(repoRoot, 'frontend', 'dist'),
		computeExe: path.join(repoRoot, 'compute', 'target', 'release', 'compute.exe'),
		protoPath: path.join(repoRoot, 'compute', 'proto', 'compute.proto'),
		userDataDir,
		logDir,
	};
}
