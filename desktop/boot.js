/**
 * CHUNK_2_DATABASE — make the boot page tell the truth.
 *
 * The page began as static markup that said "BookScout OS is starting up" forever. When the
 * database failed to start, the owner was left staring at that sentence indefinitely with no
 * explanation and nothing to do — the exact dead end the guardrails forbid. A startup screen
 * that cannot report failure is not a startup screen, it is a hang.
 *
 * A separate file rather than an inline <script> because the renderer CSP is `script-src
 * 'self'`, which blocks inline script. Loosening the policy for a progress screen would be
 * the wrong trade.
 */

(function bootStatus() {
  var bridge = window.aphub;
  var heading = document.getElementById('boot-heading');
  var detail = document.getElementById('boot-detail');
  var bar = document.getElementById('boot-bar');

  if (!bridge || !heading || !detail || !bar) return;

  /** Plain language only — no code, port, path or provider text reaches this screen. */
  function render(state, problem) {
    if (state === 'running') {
      heading.textContent = 'BookScout OS is ready.';
      detail.textContent = 'Your information is on this computer and is safe.';
      bar.hidden = true;
      return;
    }
    if (state === 'paused') {
      heading.textContent = 'BookScout OS is paused.';
      detail.textContent = 'Choose Resume processing from the BookScout OS icon to carry on.';
      bar.hidden = true;
      return;
    }
    if (state === 'unstable') {
      heading.textContent = 'BookScout OS could not finish starting.';
      // `problem` is the shell's own plain-language sentence; it always carries a next action.
      detail.textContent =
        problem || 'Restarting BookScout OS usually fixes this. Your information is safe.';
      bar.hidden = true;
      return;
    }
    heading.textContent = 'BookScout OS is starting up.';
    detail.textContent = 'This only takes a moment the first time. Your information is safe.';
    bar.hidden = false;
  }

  // Subscribe first, so a state change during the initial read is not lost.
  bridge.on('aphub:status:engine', function (payload) {
    if (payload && typeof payload === 'object') render(payload.state, payload.problem);
  });

  /**
   * Then ask once. The shell may already have finished — or failed — before this page
   * finished loading, in which case the event has been and gone and only a direct read will
   * show it.
   */
  bridge
    .invoke('aphub:shell:status')
    .then(function (res) {
      if (res && res.ok && res.data) render(res.data.engine, res.data.problem);
    })
    .catch(function () {
      /* The shell answers or it does not; the starting state is already on screen. */
    });
})();
