/**
 * What only the window manager knows: which app owns the screen, which are
 * running, and what a pin is currently holding.
 *
 * The deck can run without it — you get the settings editor and nothing else —
 * but it says so rather than inventing an answer. A dashboard that shows an app
 * as "running" because nobody told it otherwise is worse than one that admits
 * it is not connected.
 */
/**
 * A frame as the device sends it: base64 text, whatever the content type
 * claims. Kept as text rather than bytes on purpose — a Buffer of base64 looks
 * exactly like a Buffer of pixels, and the decoder cannot tell them apart.
 */
export type ScreenFrame = { body: string; contentType: string };

/**
 * Why an app is or is not running, as the window manager explains it — the
 * same shape as busybar-wm's own, repeated here so neither package imports the
 * other for a type.
 */
export type AppHealth = {
  state: 'running' | 'waiting' | 'restarting' | 'exited' | 'broken' | 'unmanaged';
  message: string;
  since?: number;
  restartAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  output: string[];
};

export type LiveState = {
  running: (name: string) => boolean;
  onScreen: () => string | null;
  pin: () => string | null;
  restart: (name: string) => Promise<void> | void;
  setPin: (name: string) => void;
  clearPin: () => void;
  /**
   * A photograph of a panel, if whoever mounted this can reach the device.
   *
   * The deck has no connection to the Bar of its own — and should not: the
   * credentials belong to the daemon in front of it, and the browser can send
   * no headers on an `<img>` anyway. So the frame is fetched by the host and
   * passed through here.
   *
   * Optional, because a host may have live state and still no way to reach the
   * hardware. Leaving it out is answered the same way a detached deck answers
   * everything else: by saying so.
   */
  screen?: (display: 0 | 1) => Promise<ScreenFrame>;
  /** Why an app is where it is; null for one the host knows nothing about. */
  health?: (name: string) => AppHealth | null;
  /**
   * Asks the host to take on an app just written into the manifest. Left out,
   * an installed app waits for the window manager's next start.
   */
  addApp?: (name: string) => Promise<void> | void;
};

export type LiveStatus = { connected: true } | { connected: false; reason: string };

export type Live = { state: LiveState; status: LiveStatus };

/** Refuses to guess. Every question answers "I do not know". */
export function detachedLive(reason = 'not mounted on a running busybar-wm'): Live {
  const no = (): never => {
    throw new DeckError('unavailable', `the window manager is not here: ${reason}`);
  };

  return {
    status: { connected: false, reason },
    state: {
      running: () => false,
      onScreen: () => null,
      pin: () => null,
      restart: no,
      setPin: no,
      clearPin: no,
    },
  };
}

export type DeckErrorKind = 'not-found' | 'invalid' | 'unavailable' | 'unauthorized';

const STATUS: Record<DeckErrorKind, number> = {
  'not-found': 404,
  invalid: 400,
  unavailable: 503,
  unauthorized: 401,
};

export class DeckError extends Error {
  constructor(
    readonly kind: DeckErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'DeckError';
  }

  get status(): number {
    return STATUS[this.kind];
  }
}
