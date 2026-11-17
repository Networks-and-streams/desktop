import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { log } from './logger';

/**
 * Per-user desktop configuration stored at `<userData>/config.json`
 * (plan §5.5: every secret of the desktop build is generated on first start
 * and kept there; the file is plain text so the user can plug in real
 * Stripe/Google credentials for payments and OAuth).
 */
export interface DesktopConfig {
	/** Single origin serving both the API and the SPA. */
	httpPort: number;
	/** gRPC port of the compute service. */
	grpcPort: number;
	/** Port of the embedded PostgreSQL (ignored when `databaseUrl` is set). */
	dbPort: number;
	/**
	 * Optional external database. When set (env `DATABASE_URL` wins over this),
	 * the embedded PostgreSQL is skipped — dev mode / escape hatch.
	 */
	databaseUrl: string | null;
	/** Backend environment secrets, generated once and persisted. */
	secrets: Record<string, string>;
}

/** Secrets that must exist before the backend can boot (zod schemas in backend/src/config). */
const GENERATED_SECRET_KEYS = ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'CREDENTIALS_ENCRYPTION_KEY', 'PAYMENT_WEBHOOK_SECRET'] as const;

/**
 * Third-party credentials the end user has to obtain themselves. Placeholders
 * keep the backend booting (the config schemas only require non-empty values);
 * Google sign-in stays inert until real values are pasted in, and payments
 * stay in PAYMENTS_TEST_MODE (local test gateway) until a real Stripe key
 * replaces its placeholder — see applyPaymentsTestMode.
 */
const PLACEHOLDER_SECRET_KEYS = [
	'STRIPE_SECRET_KEY',
	'STRIPE_WEBHOOK_SECRET',
	'GOOGLE_PAY_MER_ID',
	'GOOGLE_CLIENT_ID',
	'GOOGLE_CLIENT_SECRET',
] as const;

const CALLBACK_URL_PATTERN = /^http:\/\/127\.0\.0\.1:\d+\/oauth\/google\/callback$/;

/** Prefix used by `generateSecrets` for the not-yet-configured credentials. */
const PLACEHOLDER_PREFIX = 'placeholder_replace_me_';

/**
 * Payments test mode (expansion plan §5.7): without real Stripe credentials
 * the backend runs `PAYMENTS_TEST_MODE` — the local test gateway completes
 * payments, so the whole purchase flow can be manually verified on a desktop
 * install (the "Test purchase" button on /subscribe). Pasting a real
 * `STRIPE_SECRET_KEY` into config.json turns the flag off on the next start.
 *
 * Recomputed on every start (never trusted from config.json) so the rule
 * above always holds; the value is persisted for transparency.
 */
function applyPaymentsTestMode(secrets: Record<string, string>): void {
	const stripeKey = secrets.STRIPE_SECRET_KEY ?? '';
	const hasRealStripeKey = stripeKey.length > 0 && !stripeKey.startsWith(PLACEHOLDER_PREFIX);
	secrets.PAYMENTS_TEST_MODE = hasRealStripeKey ? 'false' : 'true';
}

function generateSecrets(): Record<string, string> {
	const secrets: Record<string, string> = {};
	for (const key of GENERATED_SECRET_KEYS) {
		secrets[key] = randomBytes(32).toString('hex');
	}
	secrets.PAYMENT_WEBHOOK_SECRET = `desktop_${randomBytes(24).toString('base64url')}`;
	for (const key of PLACEHOLDER_SECRET_KEYS) {
		secrets[key] = `placeholder_replace_me_${key.toLowerCase()}`;
	}
	return secrets;
}

function readJson(file: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
		return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
	} catch (error) {
		log(`could not read ${file} (${(error as Error).message}) — regenerating it`);
		return {};
	}
}

function port(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65536 ? value : fallback;
}

/**
 * Loads `<userData>/config.json`, creating it on first run. Missing keys are
 * filled in and written back, so upgrades (new secrets) never break a stale
 * file and user edits are always preserved.
 */
export function loadConfig(userDataDir: string): DesktopConfig {
	const file = path.join(userDataDir, 'config.json');
	const raw = readJson(file);

	const httpPort = port(raw.httpPort, 3100);
	const grpcPort = port(raw.grpcPort, 50051);
	const dbPort = port(raw.dbPort, 5433);

	const storedSecrets =
		raw.secrets !== null && typeof raw.secrets === 'object' ? (raw.secrets as Record<string, string>) : {};
	const secrets: Record<string, string> = { ...generateSecrets() };
	for (const [key, value] of Object.entries(storedSecrets)) {
		if (typeof value === 'string' && value.length > 0) {
			secrets[key] = value;
		}
	}
	// The OAuth callback is a *generated* loopback URL, not a user credential:
	// always derive it from the configured port. A value that does not look
	// like the generated one (user override, e.g. an HTTPS tunnel) is kept.
	// Without this the backend crashes on a clean machine — there is no
	// backend/.env there to supply the variable (google.config requires it).
	if (!secrets.GOOGLE_CALLBACK_URL || CALLBACK_URL_PATTERN.test(secrets.GOOGLE_CALLBACK_URL)) {
		secrets.GOOGLE_CALLBACK_URL = `http://127.0.0.1:${httpPort}/oauth/google/callback`;
	}
	// See applyPaymentsTestMode: test purchases until real Stripe keys exist.
	applyPaymentsTestMode(secrets);

	const config: DesktopConfig = {
		httpPort,
		grpcPort,
		dbPort,
		databaseUrl: typeof raw.databaseUrl === 'string' && raw.databaseUrl.length > 0 ? raw.databaseUrl : null,
		secrets,
	};

	const serialized = `${JSON.stringify(config, null, 2)}\n`;
	let current: string | null = null;
	try {
		current = fs.readFileSync(file, 'utf8');
	} catch {
		/* first run */
	}
	if (current !== serialized) {
		fs.mkdirSync(userDataDir, { recursive: true });
		fs.writeFileSync(file, serialized, { mode: 0o600 });
		log(current === null ? `created ${file}` : `updated ${file}`);
	}

	return config;
}
