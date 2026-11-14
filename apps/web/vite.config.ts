import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// In dev, the browser talks to the same origin and Vite forwards signaling to the Node server,
// exactly like Caddy (Docker) or the Worker (Cloudflare) do in production.
const SIGNAL_TARGET = process.env.SIGNAL_TARGET ?? 'http://localhost:3001';
const proxy = {
	'/ws': { target: SIGNAL_TARGET, ws: true },
	'/api': { target: SIGNAL_TARGET }
};

export default defineConfig({
	plugins: [sveltekit()],
	server: {
		port: 5173,
		strictPort: false,
		proxy
	},
	preview: {
		proxy
	}
});
