/**
 * Generates `resources/icon.png` (256×256) — the installer/window icon — and
 * `resources/splash.bmp` (640×480) — the splash the NSIS portable stub shows
 * while it extracts the app.
 *
 * electron-builder converts the PNG to the .ico sizes Windows needs, so no
 * binary icon has to live in the repo. The artwork is drawn from scratch with
 * Node's built-in zlib (no image dependencies): a dark rounded tile with a
 * small directed graph in the app's mint accent.
 *
 * The portable stub is silent by default and extracts ~800 MB into %TEMP% on
 * every launch (minutes under antivirus scanning), so without a splash the
 * user sees nothing at all — exactly the "portable only starts a background
 * shell" symptom. NSIS's BgImage plugin only accepts a 24-bit BMP with a
 * *nonzero* DPI (GitHub electron-builder#5390), which is what `encodeBmp`
 * emits.
 *
 * Run: node scripts/make-icon.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 256;

// --- tiny PNG encoder (8-bit RGBA, filter type 0 per scanline) -------------
const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(buffer) {
	let c = 0xffffffff;
	for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(typeAndData));
	return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(width, height, rgba) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // colour type: RGBA
	const raw = Buffer.alloc((width * 4 + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (width * 4 + 1)] = 0; // filter: none
		rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(raw, { level: 9 })),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

// --- drawing helpers -------------------------------------------------------
const pixels = Buffer.alloc(SIZE * SIZE * 4);

function put(x, y, [r, g, b, a = 255]) {
	if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
	const i = (y * SIZE + x) * 4;
	pixels[i] = r;
	pixels[i + 1] = g;
	pixels[i + 2] = b;
	pixels[i + 3] = a;
}

function insideRoundedTile(x, y) {
	const radius = 48;
	const cx = Math.min(Math.max(x, radius), SIZE - radius);
	const cy = Math.min(Math.max(y, radius), SIZE - radius);
	return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
	const dx = x2 - x1;
	const dy = y2 - y1;
	const lengthSq = dx * dx + dy * dy;
	const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSq));
	return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// --- artwork: 4 nodes, 5 directed edges (the demo graph's silhouette) ------
const MINT = [52, 211, 153];
const EDGE = [52, 211, 153, 235];
const NODE_FILL = [9, 9, 11];
const NODE_RING = [228, 228, 231, 255];

const nodes = [
	[64, 128],
	[136, 64],
	[136, 192],
	[204, 128],
];
const edges = [
	[0, 1],
	[0, 2],
	[1, 3],
	[2, 3],
	[1, 2],
];

for (let y = 0; y < SIZE; y++) {
	for (let x = 0; x < SIZE; x++) {
		if (!insideRoundedTile(x, y)) continue;

		// subtle vertical gradient in the tile background
		const shade = Math.round(9 + (y / SIZE) * 14);
		put(x, y, [shade, shade, shade + 3]);

		for (const [from, to] of edges) {
			if (distanceToSegment(x, y, ...nodes[from], ...nodes[to]) <= 5) {
				put(x, y, EDGE);
				break;
			}
		}

		for (const [cx, cy] of nodes) {
			const d = Math.hypot(x - cx, y - cy);
			if (d <= 17) {
				put(x, y, d >= 12 ? NODE_RING : NODE_FILL);
				break;
			}
			if (d <= 20.5) {
				put(x, y, [...MINT, 255]);
				break;
			}
		}
	}
}

// nodes get a mint core so they read at small sizes
for (const [cx, cy] of nodes) {
	for (let y = cy - 6; y <= cy + 6; y++) {
		for (let x = cx - 6; x <= cx + 6; x++) {
			if (Math.hypot(x - cx, y - cy) <= 6) put(x, y, [...MINT, 255]);
		}
	}
}

const here = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.join(here, '..', 'resources', 'icon.png');
mkdirSync(path.dirname(outFile), { recursive: true });
writeFileSync(outFile, encodePng(SIZE, SIZE, pixels));
console.log(`icon written → ${outFile}`);

// --- splash: 640×480 24-bit BMP for the portable stub ----------------------
const SPLASH_W = 640;
const SPLASH_H = 480;

/**
 * 24-bit BMP (BITMAPINFOHEADER / v3), bottom-up rows padded to 4 bytes.
 *
 * The DPI fields are deliberately non-zero (96): NSIS's BgImage plugin
 * silently ignores bitmaps that report 0 DPI — the classic "splash does
 * nothing" trap (electron-builder#5390).
 */
function encodeBmp(width, height, rgba) {
	const rowSize = Math.ceil((width * 3) / 4) * 4;
	const imageSize = rowSize * height;
	const headerSize = 14 + 40;
	const buf = Buffer.alloc(headerSize + imageSize);

	// BITMAPFILEHEADER
	buf.write('BM', 0, 'ascii');
	buf.writeUInt32LE(headerSize + imageSize, 2);
	buf.writeUInt32LE(headerSize, 10);

	// BITMAPINFOHEADER
	buf.writeUInt32LE(40, 14);
	buf.writeInt32LE(width, 18);
	buf.writeInt32LE(height, 22); // positive → bottom-up scanlines
	buf.writeUInt16LE(1, 26); // planes
	buf.writeUInt16LE(24, 28); // bpp
	buf.writeUInt32LE(0, 30); // BI_RGB
	buf.writeUInt32LE(imageSize, 34);
	buf.writeInt32LE(3780, 38); // 96 DPI horizontally (nonzero — required)
	buf.writeInt32LE(3780, 42); // 96 DPI vertically

	for (let y = 0; y < height; y++) {
		const srcRow = height - 1 - y;
		const dst = headerSize + y * rowSize;
		for (let x = 0; x < width; x++) {
			const si = (srcRow * width + x) * 4;
			const di = dst + x * 3;
			buf[di] = rgba[si + 2];
			buf[di + 1] = rgba[si + 1];
			buf[di + 2] = rgba[si];
		}
	}
	return buf;
}

// 5×7 bitmap font (rows top→bottom, '#' = ink) — only the glyphs the two
// splash lines need, plus space/comma/period.
const FONT = {
	A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
	B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
	C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
	D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
	E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
	F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
	G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
	H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
	I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
	J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
	K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
	L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
	M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
	N: ['#...#', '##..#', '#.#.#', '#.#.#', '#..##', '#...#', '#...#'],
	O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
	P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
	Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
	R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
	S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
	T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
	U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
	V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
	W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
	X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
	Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
	Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
	' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
	',': ['.....', '.....', '.....', '.....', '.##..', '.##..', '.#...'],
	'.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
};

/** Draws `text` into an RGBA buffer; each glyph advances 6×scale px. */
function drawText(rgba, width, height, x, y, text, scale, color) {
	for (let i = 0; i < text.length; i++) {
		const glyph = FONT[text[i]];
		if (!glyph) continue;
		for (let row = 0; row < 7; row++) {
			for (let col = 0; col < 5; col++) {
				if (glyph[row][col] !== '#') continue;
				for (let dy = 0; dy < scale; dy++) {
					for (let dx = 0; dx < scale; dx++) {
						const px = x + (i * 6 + col) * scale + dx;
						const py = y + row * scale + dy;
						if (px < 0 || py < 0 || px >= width || py >= height) continue;
						const di = (py * width + px) * 4;
						rgba[di] = color[0];
						rgba[di + 1] = color[1];
						rgba[di + 2] = color[2];
						rgba[di + 3] = 255;
					}
				}
			}
		}
	}
}

function textWidth(text, scale) {
	return (text.length * 6 - 1) * scale;
}

// background: the same dark family as the icon tile
const splash = Buffer.alloc(SPLASH_W * SPLASH_H * 4);
for (let y = 0; y < SPLASH_H; y++) {
	const shade = Math.round(9 + (y / SPLASH_H) * 18);
	for (let x = 0; x < SPLASH_W; x++) {
		const i = (y * SPLASH_W + x) * 4;
		splash[i] = shade;
		splash[i + 1] = shade;
		splash[i + 2] = shade + 4;
		splash[i + 3] = 255;
	}
}

// the icon artwork, alpha-composited and centred near the top
const iconX = Math.round((SPLASH_W - SIZE) / 2);
const iconY = 44;
for (let y = 0; y < SIZE; y++) {
	for (let x = 0; x < SIZE; x++) {
		const si = (y * SIZE + x) * 4;
		const a = pixels[si + 3] / 255;
		if (a === 0) continue;
		const di = ((iconY + y) * SPLASH_W + iconX + x) * 4;
		for (let c = 0; c < 3; c++) {
			splash[di + c] = Math.round(pixels[si + c] * a + splash[di + c] * (1 - a));
		}
		splash[di + 3] = 255;
	}
}

const title = 'GRAPH RESOLVER';
const subtitle = 'EXTRACTING FILES, PLEASE WAIT';
drawText(
	splash,
	SPLASH_W,
	SPLASH_H,
	Math.round((SPLASH_W - textWidth(title, 4)) / 2),
	336,
	title,
	4,
	[250, 250, 250],
);
drawText(
	splash,
	SPLASH_W,
	SPLASH_H,
	Math.round((SPLASH_W - textWidth(subtitle, 2)) / 2),
	388,
	subtitle,
	2,
	[52, 211, 153],
);

const splashFile = path.join(here, '..', 'resources', 'splash.bmp');
writeFileSync(splashFile, encodeBmp(SPLASH_W, SPLASH_H, splash));
console.log(`splash written → ${splashFile}`);
