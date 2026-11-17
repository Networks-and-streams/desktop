import type { ChildProcess } from 'node:child_process';
import { app, BrowserWindow, dialog } from 'electron';

import { loadConfig } from './config';
import { DatabaseStartupError, ensureDatabase, type DatabaseHandle } from './db';
import { probeHealth, probeTcp, waitForHealth, waitForTcp } from './health';
import { initLogger, log } from './logger';
import { resolvePaths } from './paths';
import { startBackend } from './servers/backend';
import { startCompute } from './servers/compute';
import { createWindow } from './window';

/** Budget for each service to become healthy (plan §5.3). */
const STARTUP_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 15_000;

let window: BrowserWindow | null = null;
let logFile = '';
let database: DatabaseHandle | null = null;
let compute: ChildProcess | null = null;
let backend: ChildProcess | null = null;
let ready = false;
let shuttingDown = false;
let teardownPromise: Promise<void> | null = null;

app.setAppUserModelId('com.networkstreams.graph-resolver');

if (!app.requestSingleInstanceLock()) {
	// A second launch focuses the running instance instead (see below).
	app.quit();
} else {
	app.on('second-instance', () => {
		if (window && !window.isDestroyed()) {
			if (window.isMinimized()) window.restore();
			window.focus();
		}
	});

	app.whenReady().then(start).catch(fail);
}

/**
 * Start-up sequence (plan §5.3): config/secrets → database + migrations →
 * compute → backend → window. The window only appears once `/health` answers,
 * so the user never sees a broken page.
 */
async function start(): Promise<void> {
	const paths = resolvePaths();
	logFile = initLogger(paths.logDir);
	log(`shell starting (packaged=${app.isPackaged}, resources=${paths.resourcesRoot})`);

	const config = loadConfig(paths.userDataDir);
	window = createWindow();

	// 1 — database (embedded or external) + `prisma migrate deploy`
	database = await ensureDatabase({
		userDataDir: paths.userDataDir,
		dbPort: config.dbPort,
		backendDir: paths.backendDir,
		externalUrl: process.env.DATABASE_URL ?? config.databaseUrl,
	});

	// 2 — compute (an instance left over by a hard kill is adopted, not duplicated)
	if (await probeTcp('127.0.0.1', config.grpcPort)) {
		log(`compute already listens on 127.0.0.1:${config.grpcPort} — reusing it`);
	} else {
		compute = startCompute(paths, config.grpcPort);
		watchChild(compute, 'compute');
		await waitForTcp('127.0.0.1', config.grpcPort, STARTUP_TIMEOUT_MS);
	}

	// 3 — backend (API + SPA on one origin)
	const origin = `http://127.0.0.1:${config.httpPort}`;
	if (await probeHealth(`${origin}/health`)) {
		log(`backend already healthy on ${origin} — reusing it`);
	} else {
		backend = startBackend(paths, { databaseUrl: database.url, config });
		watchChild(backend, 'backend');
		await Promise.race([
			waitForHealth(`${origin}/health`, STARTUP_TIMEOUT_MS),
			new Promise<never>((_resolve, reject) => {
				backend?.once('exit', (code) => reject(new Error(`the backend exited with code ${code} during startup`)));
			}),
		]);
	}

	if (shuttingDown || window.isDestroyed()) return;

	// 4 — reveal the UI
	await window.loadURL(origin);
	window.show();
	ready = true;
	log('startup complete');
}

/** Startup failure: explain it in a dialog, then exit with code 1. */
function fail(error: unknown): void {
	const err = error instanceof Error ? error : new Error(String(error));
	log(`FATAL: ${err.stack ?? err.message}`);

	void (async () => {
		try {
			dialog.showMessageBoxSync({
				type: 'error',
				title: 'Graph Resolver — startup failed',
				message: err.message,
				detail:
					error instanceof DatabaseStartupError && error.detail
						? error.detail
						: `Details were written to:\n${logFile}`,
			});
		} catch (dialogError) {
			log(`could not show the error dialog: ${(dialogError as Error).message}`);
		}
		await teardown();
		app.exit(1);
	})();
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`${label} timed out after ${STOP_TIMEOUT_MS} ms`)), STOP_TIMEOUT_MS);
			timer.unref();
		}),
	]);
}

/** Orderly shutdown (plan §5.3 step 6): backend → compute → postgres. */
function teardown(): Promise<void> {
	teardownPromise ??= (async () => {
		log('shutting down…');
		for (const child of [backend, compute]) {
			if (child && child.exitCode === null && child.pid) {
				try {
					child.kill();
				} catch (error) {
					log(`failed to kill pid ${child.pid}: ${(error as Error).message}`);
				}
			}
		}
		if (database) {
			try {
				await withTimeout(database.stop(), 'database stop');
			} catch (error) {
				log(`database stop failed: ${(error as Error).message}`);
			}
		}
		log('shutdown complete');
	})();
	return teardownPromise;
}

app.on('before-quit', (event) => {
	if (shuttingDown) return;
	event.preventDefault();
	shuttingDown = true;
	void teardown().finally(() => app.exit(0));
});

app.on('window-all-closed', () => {
	app.quit();
});

/** A service dying after a successful start is fatal — tell the user why. */
function watchChild(child: ChildProcess | null, name: string): void {
	child?.on('exit', (code) => {
		if (ready && !shuttingDown) {
			log(`[main] ${name} stopped unexpectedly (code=${code})`);
			dialog.showErrorBox(
				'Graph Resolver',
				`The local ${name} stopped unexpectedly (code ${code}). The application will now close.`,
			);
			app.quit();
		}
	});
}
