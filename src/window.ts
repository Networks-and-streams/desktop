import { BrowserWindow, shell } from 'electron';

import { log } from './logger';

/**
 * Loading page shown while the stack boots. A cold start (first launch after a
 * Windows reboot) can take a couple of minutes — antivirus scans the unpacked
 * `node_modules` and the disk cache is cold — so the window appears right away
 * with a spinner and a phase label instead of hiding in the background.
 * Inline `data:` URL: nothing extra to ship or resolve in dev vs packaged.
 */
const LOADING_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Graph Resolver</title>
<style>
	:root { color-scheme: dark; }
	* { margin: 0; padding: 0; box-sizing: border-box; }
	body {
		height: 100vh; display: flex; flex-direction: column;
		align-items: center; justify-content: center; gap: 24px;
		background: #09090b; color: #fafafa; user-select: none;
		font: 14px/1.5 "Segoe UI", system-ui, sans-serif;
	}
	.spinner {
		width: 40px; height: 40px; border-radius: 50%;
		border: 3px solid #27272a; border-top-color: #3b82f6;
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }
	h1 { font-size: 16px; font-weight: 600; }
	#status { color: #a1a1aa; font-size: 13px; min-height: 1.4em; }
</style>
</head>
<body>
	<div class="spinner" role="progressbar" aria-label="Loading"></div>
	<h1>Graph Resolver</h1>
	<div id="status">Starting&hellip;</div>
	<script>
		window.__setStatus = (text) => { document.getElementById('status').textContent = text; };
	</script>
</body>
</html>`;

const LOADING_URL = `data:text/html;charset=utf-8,${encodeURIComponent(LOADING_HTML)}`;

/**
 * The application window. It shows a loading page immediately (main.ts keeps
 * updating the status line while services boot) and only swaps to the SPA once
 * the whole stack is healthy, so the user never stares at a half-working page
 * — nor at an invisible process.
 */
export function createWindow(): BrowserWindow {
	const window = new BrowserWindow({
		width: 1440,
		height: 900,
		minWidth: 1024,
		minHeight: 640,
		show: false,
		backgroundColor: '#09090b',
		title: 'Graph Resolver',
		autoHideMenuBar: true,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			spellcheck: false,
		},
	});

	// External links (Google consent, docs) leave the shell for the default
	// browser instead of opening a second Electron window.
	window.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
		return { action: 'deny' };
	});

	// Real navigations must stay on http(s) — the OAuth round-trip navigates
	// this window to accounts.google.com and back to 127.0.0.1.
	window.webContents.on('will-navigate', (event, url) => {
		if (!/^https?:\/\//i.test(url)) {
			event.preventDefault();
		}
	});

	return window;
}

/** Loads the loading page and reveals the window (cold-start feedback). */
export async function showLoading(window: BrowserWindow): Promise<void> {
	await window.loadURL(LOADING_URL);
	if (!window.isDestroyed()) window.show();
}

/**
 * Updates the loading page's status line. Failures are swallowed: the SPA may
 * already have replaced the document, which is exactly the race we accept.
 */
export function setLoadingStatus(window: BrowserWindow, status: string): void {
	if (window.isDestroyed()) return;
	void window.webContents
		.executeJavaScript(`window.__setStatus && window.__setStatus(${JSON.stringify(status)})`)
		.catch(() => {
			/* document already swapped to the SPA */
		});
}
