import { BrowserWindow, shell } from 'electron';

/**
 * The application window. It stays hidden until the whole stack is healthy
 * (main.ts shows it after the health probe), so the user never stares at a
 * half-working page.
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
