// Friendly explanations for camera/microphone failures, including how to allow access in the
// browser the person is using. Plain strings only (they're shown as text, never as HTML).

import { errorName } from './camera.js';

export type MediaProblemKind = 'denied' | 'notfound' | 'busy' | 'insecure' | 'other';
export type MediaDevicesWanted = 'camera' | 'microphone' | 'both';

export interface MediaProblem {
  kind: MediaProblemKind;
  devices: MediaDevicesWanted;
}

export function classifyMediaError(err: unknown): MediaProblemKind {
  switch (errorName(err)) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'denied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'notfound';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'busy';
    case 'InsecureContextError':
      return 'insecure';
    default:
      return 'other';
  }
}

/** Thrown where the browser has no camera/microphone API at all (plain http, very old browsers). */
export function insecureContextError(): Error {
  return Object.assign(new Error('Camera and microphone need a secure (https) page'), { name: 'InsecureContextError' });
}

function devicesText(devices: MediaDevicesWanted): string {
  return devices === 'both' ? 'camera and microphone' : devices;
}

export function describeProblem(problem: MediaProblem): { title: string; detail: string } {
  const what = devicesText(problem.devices);
  const them = problem.devices === 'both' ? 'them' : 'it';
  switch (problem.kind) {
    case 'denied':
      return {
        title: `Your ${what} ${problem.devices === 'both' ? 'are' : 'is'} blocked`,
        detail: `Your browser hasn't allowed this page to use your ${what}. Here's how to allow ${them}:`,
      };
    case 'notfound':
      return {
        title: `No ${what} found`,
        detail: `Check that ${them === 'it' ? "it's" : "they're"} plugged in and switched on, then try again.`,
      };
    case 'busy':
      return {
        title: `Your ${what} ${problem.devices === 'both' ? 'are' : 'is'} busy`,
        detail: `Another app or browser tab may be using ${them}. Close it and try again.`,
      };
    case 'insecure':
      return {
        title: 'Camera and microphone are unavailable here',
        detail: 'Browsers only allow them on secure (https) pages. Open this call with an https:// link.',
      };
    default:
      return { title: `Couldn't start your ${what}`, detail: 'Try again, or choose a different device.' };
  }
}

/** What you can still do when this problem isn't fixed. */
export function fallbackText(problem: MediaProblem): string {
  return problem.devices === 'camera'
    ? "You can still join: you'll be heard but not seen, and can turn the camera on later."
    : "You can still join with chat only: you'll see and hear everyone.";
}

/**
 * Where to allow camera and microphone access, for the browser in `userAgent`. `touch` tells an
 * iPad (which reports itself as a Mac) apart from a Mac.
 */
export function permissionSteps(userAgent: string, touch = false): string[] {
  const ua = userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touch);
  const android = /Android/.test(ua);
  const firefox = /Firefox\/|FxiOS\//.test(ua);
  const edge = /Edg(e|A|iOS)?\//.test(ua);
  const chromium = /Chrome\/|CriOS\//.test(ua) || edge;
  const safari = /Safari\//.test(ua) && !chromium && !firefox;
  const mac = /Macintosh|Mac OS X/.test(ua) && !ios;
  const windows = /Windows/.test(ua);

  if (ios) {
    return [
      safari
        ? 'Tap the page settings button (aA) in the address bar, then Website Settings.'
        : 'Open the page settings from the address bar or the browser menu.',
      'Set Camera and Microphone to Allow (or Ask), then reload the page.',
      "Still blocked? Open the Settings app, find your browser, and turn on Camera and Microphone.",
    ];
  }
  if (android) {
    return [
      'Tap the icon at the left of the address bar, then Permissions (or Site settings).',
      'Allow Camera and Microphone, then try again.',
      "Still blocked? Open Android Settings → Apps → your browser → Permissions, and allow them there.",
    ];
  }
  const steps = firefox
    ? [
        'Click the crossed-out camera or microphone icon in the address bar.',
        'Remove the "Blocked" setting, then try again and choose Allow.',
      ]
    : safari
      ? [
          'In the menu bar, choose Safari → Settings for This Website (or Settings → Websites).',
          'Set Camera and Microphone to Allow, then try again.',
        ]
      : [
          'Click the icon at the left of the address bar to open the site settings.',
          'Set Camera and Microphone to Allow, then try again (you may need to reload the page).',
        ];
  if (mac) steps.push('On a Mac, also check System Settings → Privacy & Security → Camera and Microphone, and allow your browser.');
  else if (windows) steps.push('On Windows, also check Settings → Privacy & security → Camera and Microphone.');
  return steps;
}
