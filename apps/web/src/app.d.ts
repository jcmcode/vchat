/// <reference types="@sveltejs/kit" />

declare namespace App {
	// interface Error {}
	// interface Locals {}
	// interface PageData {}
	// interface Platform {}
}

declare module 'simple-peer/simplepeer.min.js' {
	const SimplePeer: unknown;
	export default SimplePeer;
}
