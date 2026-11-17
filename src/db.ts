import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { log, logChild } from './logger';

/**
 * `embedded-postgres` ships ESM only (`"type": "module"`), so it is pulled in
 * with a dynamic import — the shell itself stays CommonJS (Electron main) and
 * Node ≥22 loads the ESM dependency transparently. The `resolution-mode`
 * attribute tells TypeScript to resolve the package's types as an ESM import
 * (which is what the runtime dynamic import does).
 */
type EmbeddedPostgresModule = typeof import('embedded-postgres', { with: { 'resolution-mode': 'import' } });
type EmbeddedPostgresClass = EmbeddedPostgresModule['default'];
type EmbeddedPostgresInstance = InstanceType<EmbeddedPostgresClass>;

const APP_DATABASE = 'streams';
const MIGRATE_TIMEOUT_MS = 180_000;

/** Postgres refused to start (admin token, port conflict, corrupt cluster…). */
export class DatabaseStartupError extends Error {
	constructor(
		message: string,
		readonly detail: string,
	) {
		super(message);
	}
}

export interface DatabaseHandle {
	url: string;
	/** True when this process owns the embedded PostgreSQL instance. */
	embedded: boolean;
	stop(): Promise<void>;
}

export interface EnsureDatabaseOptions {
	userDataDir: string;
	dbPort: number;
	/** Where `prisma migrate deploy` runs (needs prisma/, prisma.config.ts, node_modules). */
	backendDir: string;
	/** `DATABASE_URL` override (env wins over config.json) — skips the embedded server. */
	externalUrl: string | null;
}

/** Postgres on Windows refuses to run under an administrator token. */
export function isAdministrativeRightsError(text: string): boolean {
	return /administrative|administrator|elevated|run as (a )?root|access is denied/i.test(text);
}

/**
 * Starts the database (plan §5.4): embedded PostgreSQL on Windows, or an
 * externally supplied URL (dev mode), then applies `prisma migrate deploy`
 * so a fresh install ends up with the full schema.
 */
export async function ensureDatabase(options: EnsureDatabaseOptions): Promise<DatabaseHandle> {
	if (options.externalUrl) {
		log(`external database configured — the embedded server is skipped`);
		await runMigrate(options.backendDir, options.externalUrl);
		return { url: options.externalUrl, embedded: false, stop: async () => {} };
	}

	const databaseDir = path.join(options.userDataDir, 'pgdata');
	const output: string[] = [];
	const { default: EmbeddedPostgres } = await import('embedded-postgres');
	const pg = new EmbeddedPostgres({
		databaseDir,
		user: 'postgres',
		password: 'postgres',
		port: options.dbPort,
		persistent: true,
		// Without these initdb inherits the Windows locale (WIN1251 on some
		// machines) and text search falls back to `simple` — force UTF8 so
		// Cyrillic graph names survive a round-trip.
		initdbFlags: ['--encoding=UTF8', '--no-locale'],
		onLog: (message) => {
			output.push(message);
			log(`[postgres] ${message}`);
		},
		onError: (message) => {
			output.push(String(message));
			log(`[postgres] ${String(message)}`);
		},
	});

	const rawOutput = () => output.join('');
	const fail = (fallback: string): never => {
		const detail = rawOutput().trim().slice(-4000);
		throw new DatabaseStartupError(friendlyDatabaseError(detail, options.dbPort, fallback), detail);
	};

	// `initialise()` runs initdb unconditionally, so a data directory left over
	// from a previous run must be detected here (PG_VERSION is written by initdb).
	const initialised = fs.existsSync(path.join(databaseDir, 'PG_VERSION'));
	if (initialised) {
		log(`reusing the existing data directory ${databaseDir}`);
	} else {
		try {
			await pg.initialise();
		} catch {
			fail('PostgreSQL could not initialise its data directory.');
		}
	}

	let started = false;
	let stopWithPgCtl: (() => Promise<void>) | null = null;
	try {
		await pg.start();
		started = true;
	} catch {
		// `start()` rejects when postgres exits early — typically because a
		// previous run was hard-killed and left something behind: the
		// postmaster itself, or (a Windows quirk) an `io_worker` child that
		// outlives its postmaster and keeps holding the listen socket while
		// `postmaster.pid` is already gone. Clear whatever is left *if it
		// provably belongs to us*, then start fresh: a server this process
		// started can be stopped cleanly on quit, an adopted one could not.
		const cleared = await clearLeftoverServer(databaseDir, options.dbPort);
		if (cleared) {
			try {
				await pg.start();
				started = true;
			} catch {
				/* fall through */
			}
		}
		if (!started && (isElevatedToken() || isAdministrativeRightsError(rawOutput()))) {
			// An elevated administrator token is the one state `postgres.exe`
			// hard-refuses to run in. `pg_ctl` can still start the very same
			// binary: the PostgreSQL frontend utilities re-exec themselves
			// with a restricted token whose DACL carries an ACE for the
			// current user — without that ACE `CreatePipe`/`OpenProcessToken`
			// fail inside the restricted process ("Permission denied" while
			// running `postgres -V` in `find_other_exec`), which is exactly
			// what happens when a restricted token is built from scratch.
			log('direct start refused — falling back to pg_ctl (elevated token)');
			// The library still holds the dead direct-spawn child; drop it so
			// its exit-hook does not wait for a process that will never emit
			// 'exit'.
			(pg as unknown as { process?: unknown }).process = undefined;
			try {
				const pgCtl = await resolvePgCtl();
				stopWithPgCtl = await startClusterWithPgCtl({
					pgCtl,
					databaseDir,
					dbPort: options.dbPort,
					userDataDir: options.userDataDir,
					output,
				});
				started = true;
			} catch (error) {
				output.push(String(error));
				log(`pg_ctl could not start the server: ${String(error)}`);
			}
		}
		if (!started) {
			fail(`PostgreSQL could not start on port ${options.dbPort}.`);
		}
	}

	const url = `postgresql://postgres:postgres@127.0.0.1:${options.dbPort}/${APP_DATABASE}?schema=public`;
	await ensureAppDatabase(pg);
	await runMigrate(options.backendDir, url);

	return {
		url,
		embedded: true,
		stop: async () => {
			if (stopWithPgCtl !== null) {
				await stopWithPgCtl();
			} else {
				await pg.stop();
			}
		},
	};
}

/**
 * True when running from an elevated administrator token — the state
 * `postgres.exe` refuses to start in. High integrity (`S-1-16-12288`) only
 * exists on an elevated admin token: a standard user, or an administrator
 * running with UAC filtering, never has it — and there the direct spawn in
 * `start()` works fine.
 */
function isElevatedToken(): boolean {
	if (process.platform !== 'win32') {
		return false;
	}
	try {
		const result = spawnSync('whoami', ['/groups'], { windowsHide: true, encoding: 'utf8', timeout: 5_000 });
		// SIDs in `whoami` output are locale-independent (group names are not).
		return (result.stdout ?? '').includes('S-1-16-12288');
	} catch {
		return false;
	}
}

/**
 * Absolute path of the bundled `pg_ctl`. The `embedded-postgres` package
 * exports only its entry point, so its `binary.js` — the platform resolution
 * the library itself uses — is loaded by absolute file URL.
 */
async function resolvePgCtl(): Promise<string> {
	const entry = createRequire(__filename).resolve('embedded-postgres');
	const binaries = (await import(pathToFileURL(path.join(path.dirname(entry), 'binary.js')).href)) as {
		default: () => Promise<{ pg_ctl: string }>;
	};
	const { pg_ctl } = await binaries.default();
	return pg_ctl;
}

/**
 * Runs `pg_ctl`, appending its output to `logFile`, and resolves with the
 * exit code (-1 when the timeout killed it).
 *
 * Stdio goes to file descriptors instead of pipes on purpose: postgres
 * inherits pg_ctl's std handles, so a pipe would stay open for the lifetime
 * of the server and the 'close' event would never fire.
 */
function runPgCtl(pgCtl: string, args: string[], logFile: string, timeoutMs: number): Promise<number> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let fd: number | null = null;
		const finish = (fn: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (fd !== null) {
				try {
					fs.closeSync(fd);
				} catch {
					/* already closed */
				}
				fd = null;
			}
			fn();
		};
		try {
			fd = fs.openSync(logFile, 'a');
		} catch (error) {
			reject(error);
			return;
		}
		const child = spawn(pgCtl, args, { windowsHide: true, stdio: ['ignore', fd, fd] });
		const timer = setTimeout(() => {
			child.kill();
			finish(() => reject(new Error(`pg_ctl ${args[0] ?? ''} timed out after ${timeoutMs} ms`)));
		}, timeoutMs);
		child.on('error', (error) => finish(() => reject(error)));
		child.on('exit', (code) => finish(() => resolve(code ?? -1)));
	});
}

/**
 * Starts the cluster through `pg_ctl` and returns a stop function for it.
 * This is the supported way to launch the server from an elevated token:
 * `pg_ctl` re-execs itself with PostgreSQL's own restricted token (which
 * carries the user ACE that keeps `CreatePipe` working) and only then spawns
 * `postgres.exe` — see the call site in `ensureDatabase`.
 *
 * On failure the caller-visible output is replaced with the pg_ctl/server
 * logs: the direct-spawn output only says "administrative rights", while
 * these carry the real cause (port conflict, corrupt cluster, …).
 */
async function startClusterWithPgCtl(params: {
	pgCtl: string;
	databaseDir: string;
	dbPort: number;
	userDataDir: string;
	output: string[];
}): Promise<() => Promise<void>> {
	const { pgCtl, databaseDir, dbPort, userDataDir, output } = params;
	const serverLog = path.join(userDataDir, 'postgres-server.log');
	const controlLog = path.join(userDataDir, 'pg-ctl.log');
	const tail = (file: string): string => {
		try {
			return fs.readFileSync(file, 'utf8').slice(-4000);
		} catch {
			return '';
		}
	};
	const explainAndFail = (reason: string): never => {
		output.length = 0;
		output.push(reason, tail(controlLog), tail(serverLog));
		throw new Error(reason);
	};

	try {
		fs.writeFileSync(serverLog, '');
		fs.writeFileSync(controlLog, '');
	} catch {
		/* diagnostics only — pg_ctl appends regardless */
	}

	const startCode = await runPgCtl(
		pgCtl,
		['start', '-D', databaseDir, '-o', `-p ${dbPort}`, '-w', '-l', serverLog],
		controlLog,
		150_000,
	).catch((error: unknown) => explainAndFail(String(error)));
	if (startCode !== 0) {
		explainAndFail(`pg_ctl start exited with code ${startCode}`);
	}
	if (!(await probePort(dbPort))) {
		explainAndFail('pg_ctl reported success but the port is not accepting connections');
	}
	log(`pg_ctl started the embedded server on port ${dbPort} (server log: ${serverLog})`);

	return async () => {
		const stopCode = await runPgCtl(
			pgCtl,
			['stop', '-D', databaseDir, '-m', 'fast', '-w'],
			controlLog,
			60_000,
		).catch(() => -1);
		if (stopCode !== 0) {
			// Already stopped, or pg_ctl could not reach the server — make
			// sure no postmaster of ours survives this process.
			const pid = readPostmasterPid(databaseDir);
			if (pid !== null && isProcessAlive(pid)) {
				await killPid(pid);
			}
			await waitForPortFree(dbPort, 5000);
		}
	};
}

/**
 * `embedded-postgres.createDatabase()` issues a plain CREATE DATABASE (and
 * requires its own process handle), so existence is checked explicitly here —
 * this also works for a recovered, externally started server.
 */
async function ensureAppDatabase(pg: EmbeddedPostgresInstance): Promise<void> {
	const client = pg.getPgClient('postgres', '127.0.0.1');
	try {
		await client.connect();
		const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [APP_DATABASE]);
		if ((existing.rowCount ?? 0) === 0) {
			await client.query(`CREATE DATABASE ${client.escapeIdentifier(APP_DATABASE)}`);
			log(`created database "${APP_DATABASE}"`);
		}
	} finally {
		await client.end().catch(() => undefined);
	}
}

/**
 * Clears processes left over from a previous run that was hard-killed
 * (task manager, crash, `taskkill /f`). Candidates are the postmaster
 * recorded in `postmaster.pid` and whoever currently listens on our port.
 *
 * Safety: a candidate is only killed when its command line proves it is the
 * *bundled* PostgreSQL (`embedded-postgres` in the path) — a stale
 * `postmaster.pid` can point at an unrelated process whose PID was reused,
 * and a foreign server squatting on the port must not be touched.
 *
 * Returns true when something of ours was cleared (a retry of `start()` is
 * then worthwhile), false when there was nothing safe to clear.
 */
async function clearLeftoverServer(databaseDir: string, port: number): Promise<boolean> {
	const candidates = new Set<number>();
	const recorded = readPostmasterPid(databaseDir);
	if (recorded !== null && isProcessAlive(recorded)) {
		candidates.add(recorded);
	}
	const owner = await findListenPid(port);
	if (owner !== null) {
		candidates.add(owner);
	}

	let cleared = false;
	for (const pid of candidates) {
		const commandLine = await commandLineOf(pid);
		if (commandLine === null || !commandLine.toLowerCase().includes('embedded-postgres')) {
			log(`pid ${pid} is not the bundled PostgreSQL (cmdline: ${commandLine ?? 'unavailable'}) — leaving it alone`);
			continue;
		}
		log(`stopping a leftover bundled PostgreSQL process (pid ${pid})`);
		await killPid(pid);
		cleared = true;
	}
	if (cleared) {
		await waitForPortFree(port, 5000);
	}
	return cleared;
}

function readPostmasterPid(databaseDir: string): number | null {
	try {
		const firstLine = fs.readFileSync(path.join(databaseDir, 'postmaster.pid'), 'utf8').split(/\r?\n/)[0];
		const pid = Number.parseInt(firstLine ?? '', 10);
		return Number.isInteger(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** PID of the process LISTENING on `port` (via `netstat -ano`), or null. */
function findListenPid(port: number): Promise<number | null> {
	return new Promise((resolve) => {
		let settled = false;
		const done = (value: number | null) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		const child = spawn('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
		let out = '';
		child.stdout?.on('data', (chunk: Buffer) => {
			out += chunk.toString();
		});
		child.on('error', () => done(null));
		const timer = setTimeout(() => {
			child.kill();
			done(null);
		}, 5000);
		child.on('exit', () => {
			clearTimeout(timer);
			// e.g. "  TCP    127.0.0.1:5433    0.0.0.0:0    LISTENING    1234"
			const pattern = new RegExp(`^\\s*TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$`, 'i');
			for (const line of out.split(/\r?\n/)) {
				const match = line.match(pattern);
				if (match) {
					done(Number(match[1]));
					return;
				}
			}
			done(null);
		});
	});
}

/** Command line of a live process (via CIM), or null when unavailable. */
function commandLineOf(pid: number): Promise<string | null> {
	return new Promise((resolve) => {
		let settled = false;
		const done = (value: string | null) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		const child = spawn(
			'powershell',
			[
				'-NoProfile',
				'-NonInteractive',
				'-Command',
				`(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
			],
			{ windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
		);
		let out = '';
		child.stdout?.on('data', (chunk: Buffer) => {
			out += chunk.toString();
		});
		child.on('error', () => done(null));
		const timer = setTimeout(() => {
			child.kill();
			done(null);
		}, 8000);
		child.on('exit', () => {
			clearTimeout(timer);
			done(out.trim() || null);
		});
	});
}

async function waitForPortFree(port: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!(await probePort(port))) return;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

function probePort(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.connect({ host: '127.0.0.1', port });
		const done = (ok: boolean) => {
			socket.removeAllListeners();
			socket.destroy();
			resolve(ok);
		};
		socket.setTimeout(2000, () => done(false));
		socket.on('connect', () => done(true));
		socket.on('error', () => done(false));
	});
}

async function killPid(pid: number): Promise<void> {
	log(`stopping leftover process ${pid}`);
	await new Promise<void>((resolve) => {
		const killer = spawn('taskkill', ['/pid', String(pid), '/f', '/t'], { windowsHide: true, stdio: 'ignore' });
		killer.on('error', () => resolve());
		killer.on('exit', () => resolve());
	});
}

/** Turns raw postgres output into a message a user can act on. */
function friendlyDatabaseError(detail: string, dbPort: number, fallback: string): string {
	if (isAdministrativeRightsError(detail)) {
		return (
			'PostgreSQL refused to run with administrative rights.\n\n' +
			'Start Graph Resolver as a regular (non-administrator) user — the bundled ' +
			'database does not launch from an elevated token.'
		);
	}
	if (/address already in use|could not bind|10048|another server might be already running/i.test(detail)) {
		return `Port ${dbPort} is already in use by another program. Change "dbPort" in config.json and retry.`;
	}
	if (/password authentication failed|does not exist|connection refused/i.test(detail)) {
		return `${fallback}\n\n${detail.slice(-800)}`;
	}
	return fallback;
}

/**
 * Applies the bundled Prisma migrations with the CLI shipped in
 * `resources/backend` (dev mode uses `backend/node_modules` — same layout).
 * Runs on every start; `migrate deploy` is idempotent.
 */
function runMigrate(backendDir: string, databaseUrl: string): Promise<void> {
	const prismaCli = path.join(backendDir, 'node_modules', 'prisma', 'build', 'index.js');
	if (!fs.existsSync(prismaCli)) {
		return Promise.reject(
			new Error(`Prisma CLI not found at ${prismaCli} — the desktop bundle is incomplete.`),
		);
	}

	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [prismaCli, 'migrate', 'deploy'], {
			cwd: backendDir,
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DATABASE_URL: databaseUrl },
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
		});

		let output = '';
		const capture = (chunk: Buffer) => {
			output += chunk.toString();
			logChild('prisma', chunk);
		};
		child.stdout?.on('data', capture);
		child.stderr?.on('data', capture);

		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`prisma migrate deploy timed out after ${MIGRATE_TIMEOUT_MS} ms`));
		}, MIGRATE_TIMEOUT_MS);

		child.on('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on('exit', (code) => {
			clearTimeout(timer);
			if (code === 0) {
				log('prisma migrate deploy completed');
				resolve();
			} else {
				reject(new Error(`prisma migrate deploy failed (exit ${code}):\n${output.slice(-4000)}`));
			}
		});
	});
}
