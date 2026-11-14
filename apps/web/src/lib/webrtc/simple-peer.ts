// simple-peer's main entry depends on Node built-ins (events, util, streams) that Vite does not
// polyfill for the browser. Its prebuilt bundle ships with those polyfills, so use that instead.
import type SimplePeerType from 'simple-peer';
import SimplePeerBundle from 'simple-peer/simplepeer.min.js';

const SimplePeer = SimplePeerBundle as typeof SimplePeerType;
export default SimplePeer;
