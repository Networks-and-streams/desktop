/**
 * Builds the production backend folder that ships inside the installer
 * (plan §5.2, stage `prepare-backend`):
 *
 *   desktop/resources/backend/
 *     package.json + package-lock.json  → `npm ci --omit=dev`
 *     prisma/ + prisma.config.ts        → `prisma migrate deploy` on first start
 *     dist/                             → compiled NestJS app
 *     node_modules/                     → production deps + prisma CLI + dotenv
 *
 * `prisma` (CLI) and `dotenv` are devDependencies of the backend — a build
 * toolchain there — but the desktop shell runs `migrate deploy` on the end
 * user's machine, so both are installed explicitly *without* being saved to
 * package.json. Everything else comes from the lockfile via `npm ci`.
 *
 * Run: npm run prepare-backend
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, '..');
const repoRoot = path.resolve(desktopDir, '..');
const backendDir = path.join(repoRoot, 'backend');
const targetDir = path.join(desktopDir, 'resources', 'backend');
const isWindows = process.platform === 'win32';

function run(command, args, cwd) {
	const printable = `${command} ${args.map((arg) => `"${arg}"`).join(' ')}`;
	console.log(`\n> ${printable}`);
	const result = isWindows
		? spawnSync(printable, { cwd, stdio: 'inherit', shell: true })
		: spawnSync(command, args, { cwd, stdio: 'inherit' });
	if (result.status !== 0) {
		throw new Error(`command failed with exit code ${result.status}: ${printable}`);
	}
}

function main() {
	// 1 — stage the backend sources the runtime needs.
	rmSync(targetDir, { recursive: true, force: true });
	mkdirSync(targetDir, { recursive: true });

	for (const file of ['package.json', 'package-lock.json', 'prisma.config.ts']) {
		cpSync(path.join(backendDir, file), path.join(targetDir, file));
	}
	cpSync(path.join(backendDir, 'prisma'), path.join(targetDir, 'prisma'), { recursive: true });
	cpSync(path.join(backendDir, 'dist'), path.join(targetDir, 'dist'), { recursive: true });

	// 2 — production dependencies straight from the lockfile.
	run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], targetDir);

	// 3 — runtime tooling that is a devDependency upstream (see header).
	// `--omit=dev` is essential here: without it this install reconciles the
	// *whole* tree against the staged package.json and drags every devDependency
	// (jest, eslint, @swc/core, … — ~490 packages) into the bundle.
	const backendPkg = JSON.parse(readFileSync(path.join(backendDir, 'package.json'), 'utf8'));
	run(
		'npm',
		[
			'install',
			'--omit=dev',
			'--no-save',
			'--no-audit',
			'--no-fund',
			`prisma@${backendPkg.devDependencies.prisma}`,
			`dotenv@${backendPkg.devDependencies.dotenv}`,
		],
		targetDir,
	);

	// 4 — refuse to package a folder the app could not boot from.
	const required = [
		'dist/main.js',
		'dist/generated/prisma/client.js',
		'prisma/migrations',
		'node_modules/prisma/build/index.js',
		'node_modules/dotenv/package.json',
		'node_modules/@prisma/client/package.json',
		'node_modules/@prisma/adapter-pg/package.json',
		'node_modules/pg/package.json',
		'node_modules/bcrypt/package.json',
	];
	const missing = required.filter((rel) => !existsSync(path.join(targetDir, rel)));
	if (missing.length > 0) {
		throw new Error(`staged backend is incomplete, missing:\n  ${missing.join('\n  ')}`);
	}

	console.log(`\nprepare-backend OK → ${targetDir}`);
}

try {
	main();
} catch (error) {
	console.error(`\nprepare-backend FAILED: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
