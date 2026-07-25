/**
 * CHUNK_1_SHELL — supervisor state and its plain-language rendering.
 *
 * Pure, so the gate can assert the property that actually matters: the tray and the status
 * panel show words, never codes. Spec §16 and the "never surface a code to the user" rule
 * in CLAUDE.md both land here.
 */

export type EngineState = 'starting' | 'running' | 'paused' | 'unstable';

export const ENGINE_STATES: readonly EngineState[] = Object.freeze([
  'starting',
  'running',
  'paused',
  'unstable',
]);

/**
 * The tray tooltip and menu header. Every state maps to a sentence a non-technical owner
 * can act on; `unstable` deliberately carries the reassurance the spec's ENGINE_UNSTABLE
 * copy requires, because that is the state where a user most fears losing their data.
 */
export function engineStateLabel(state: EngineState): string {
  switch (state) {
    case 'starting':
      return 'AP-Hub is starting up';
    case 'running':
      return 'AP-Hub is running';
    case 'paused':
      return 'AP-Hub is paused';
    case 'unstable':
      return 'AP-Hub is having trouble starting. Your information is safe.';
  }
}
