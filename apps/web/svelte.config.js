import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter({
			fallback: 'index.html'
		}),
		// SvelteKit emits this as a <meta> CSP with hashes for its inline boot script, so it works
		// the same behind Caddy, on Cloudflare, or on any static host.
		csp: {
			mode: 'hash',
			directives: {
				'default-src': ['self'],
				'script-src': ['self'],
				'style-src': ['self', 'unsafe-inline'],
				'img-src': ['self', 'blob:', 'data:'],
				'media-src': ['self', 'blob:'],
				// ws:/wss: so a custom signaling server can be set in Settings.
				'connect-src': ['self', 'ws:', 'wss:'],
				'object-src': ['none'],
				'base-uri': ['self'],
				'form-action': ['self']
			}
		}
	}
};

export default config;
