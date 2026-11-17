import fs from 'node:fs';
import path from 'node:path';

/**
 * Minimal file logger for the desktop shell. Everything the shell and its
 * child processes emit lands in `<logs>/main.log` (plan §5.3), which is the
 * first place to look when an installed build misbehaves.
 */

let logStream: fs.WriteStream | null = null;
const childBuffers = new Map<string, string>();

export function initLogger(logDir: string): string {
	fs.mkdirSync(logDir, { recursive: true });
	const file = path.join(logDir, 'main.log');
	logStream = fs.createWriteStream(file, { flags: 'a' });
	return file;
}

export function log(message: string): void {
	const line = `[${new Date().toISOString()}] ${message}`;
	logStream?.write(`${line}\n`);
	console.log(line);
}

/** Pipes a child-process chunk into the log, grouping partial lines. */
export function logChild(source: string, chunk: Buffer | string): void {
	const pending = (childBuffers.get(source) ?? '') + chunk.toString();
	const lines = pending.split(/\r?\n/);
	childBuffers.set(source, lines.pop() ?? '');
	for (const line of lines) {
		if (line.trim().length > 0) {
			log(`[${source}] ${line}`);
		}
	}
}
