const esbuild = require("esbuild");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

async function main() {
	// Plugin to fix ts-capstone's ESM/CJS mismatch:
	// libcapstone.js uses module.exports but capstone.ts imports it as ESM default.
	// We inject a default export wrapper so esbuild can resolve it.
	const capstoneCjsFixPlugin = {
		name: 'capstone-cjs-fix',
		setup(build) {
			build.onLoad({ filter: /ts-capstone[/\\]src[/\\]libcapstone\.js$/ }, async (args) => {
				const fs = require('fs');
				let contents = fs.readFileSync(args.path, 'utf8');
				// Append an ESM-compatible default export
				contents += '\nexport default LibCapstone;\n';
				return { contents, loader: 'js' };
			});
		},
	};

	const commonOptions = {
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		logLevel: 'silent',
		plugins: [capstoneCjsFixPlugin, esbuildProblemMatcherPlugin],
	};

	// VSCode extension build
	const extCtx = await esbuild.context({
		...commonOptions,
		entryPoints: ['src/extension.ts'],
		outfile: 'dist/extension.js',
		external: ['vscode'],
	});

	// Standalone MCP server build
	const mcpCtx = await esbuild.context({
		...commonOptions,
		entryPoints: ['src/mcp/server.ts'],
		outfile: 'dist/mcp-server.js',
		banner: { js: '#!/usr/bin/env node' },
	});

	if (watch) {
		await extCtx.watch();
		await mcpCtx.watch();
	} else {
		await extCtx.rebuild();
		await mcpCtx.rebuild();
		await extCtx.dispose();
		await mcpCtx.dispose();
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
