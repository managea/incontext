const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

// Builds the Obsidian plugin into obsidian/dist: main.js, styles.css, and manifest.json with the extension's version,
// so each release of the extension carries the plugin with the same version.
const dist = path.join(__dirname, 'dist');

async function main() {
	fs.mkdirSync(dist, { recursive: true });
	const { id, name, ...rest } = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
	const { version } = require('../package.json');
	fs.writeFileSync(path.join(dist, 'manifest.json'), `${JSON.stringify({ id, name, version, ...rest }, null, 2)}\n`);
	fs.copyFileSync(path.join(__dirname, 'styles.css'), path.join(dist, 'styles.css'));
	await esbuild.build({
		entryPoints: [path.join(__dirname, 'main.ts')],
		bundle: true,
		format: 'cjs',
		target: 'es2022',
		outfile: path.join(dist, 'main.js'),
		// Obsidian provides these at runtime
		external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*'],
		logLevel: 'info',
	});
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
