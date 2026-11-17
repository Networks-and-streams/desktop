import http from 'node:http';
import net from 'node:net';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Probes the backend liveness endpoint. The body matters: an unrelated service
 * squatting on the port must not be mistaken for our backend (the endpoint
 * answers exactly `{"status":"ok"}`).
 */
export function probeHealth(url: string): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (ok: boolean) => {
			if (settled) return;
			settled = true;
			resolve(ok);
		};

		const request = http.get(url, (response) => {
			let body = '';
			response.on('data', (chunk: Buffer) => {
				if (body.length < 512) body += chunk.toString();
			});
			response.on('end', () => finish((response.statusCode ?? 0) === 200 && body.includes('"ok"')));
			response.on('error', () => finish(false));
		});
		request.setTimeout(2000, () => request.destroy());
		request.on('error', () => finish(false));
	});
}

/** Single TCP probe (used for the compute gRPC port). */
export function probeTcp(host: string, port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.connect({ host, port });
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

export async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await probeHealth(url)) return;
		if (Date.now() >= deadline) {
			throw new Error(`timed out after ${timeoutMs} ms waiting for ${url}`);
		}
		await sleep(300);
	}
}

export async function waitForTcp(host: string, port: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await probeTcp(host, port)) return;
		if (Date.now() >= deadline) {
			throw new Error(`timed out after ${timeoutMs} ms waiting for ${host}:${port}`);
		}
		await sleep(300);
	}
}
