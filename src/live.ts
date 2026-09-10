/**
 * What only the window manager knows: which app owns the screen, which are
 * running, and what a pin is currently holding.
 *
 * The deck can run without it — you get the settings editor and nothing else —
 * but it says so rather than inventing an answer. A dashboard that shows an app
 * as "running" because nobody told it otherwise is worse than one that admits
 * it is not connected.
 */
export type LiveState = {
  running: (name: string) => boolean;
  onScreen: () => string | null;
  pin: () => string | null;
  restart: (name: string) => Promise<void> | void;
  setPin: (name: string) => void;
  clearPin: () => void;
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
