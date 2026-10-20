// The page behind http://localhost:<port>/open#@project/path:L34:43 links (src/LinkServer.ts): hands the reference
// in the fragment to the VS Code window that served the page. The fragment stays in the browser until this
// script posts it to /launch.
(function () {
  const status = document.getElementById('status');
  const fallback = document.getElementById('fallback');
  const uriPrefix = document.querySelector('meta[name="incontext-uri-prefix"]').content;
  // The Claude app's own Browser pane; links Cmd+clicked in the app open in the default browser instead
  const inClaudeApp = navigator.userAgent.includes('Claude/');
  let attempt = 0;

  function decode(text) {
    try {
      return decodeURIComponent(text);
    } catch {
      return undefined;
    }
  }

  // The checks /launch makes too: one reference, without a `..` segment that could step out of its folder.
  // References keep their percent-encoding (a space is %20) and are decoded when VS Code resolves them,
  // so the decoded form must not hold `..` either.
  function isReference(reference) {
    if (!/^@[^\s@]+$/.test(reference)) {
      return false;
    }
    const path = reference.slice(1);
    return ![path, decode(path)].some(form => form !== undefined && /(^|[\/\\])\.\.([\/\\:#]|$)/.test(form));
  }

  function showFallback(reference) {
    fallback.href = uriPrefix + '/open?' + encodeURIComponent(JSON.stringify({ reference }));
    fallback.textContent = 'Open ' + (decode(reference) ?? reference) + ' with a vscode:// link instead';
    fallback.hidden = false;
  }

  async function openFromFragment() {
    const current = ++attempt;
    fallback.hidden = true;
    fallback.removeAttribute('href');
    const reference = location.hash.slice(1);
    if (reference) {
      // Drop the fragment, so clicking the same link again changes it and fires hashchange
      history.replaceState(null, '', location.pathname);
    }
    const label = decode(reference) ?? reference;
    if (!isReference(reference)) {
      status.textContent = 'This link does not hold an incontext reference.';
      return;
    }
    status.textContent = 'Opening ' + label + ' in VS Code…';

    let problem;
    try {
      const response = await fetch('/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Incontext': '1' },
        body: JSON.stringify({ reference }),
        cache: 'no-store',
        credentials: 'omit',
      });
      if (current !== attempt) {
        return;
      }
      if (response.ok) {
        if (inClaudeApp) {
          status.textContent = 'Opened ' + label + ' in VS Code.';
        } else {
          // A Cmd+click in the Claude app opens a new browser tab for each link. Browsers let a page close
          // its tab when the tab's history holds only that page.
          status.textContent = 'Opened ' + label + ' in VS Code. You can close this tab.';
          window.close();
        }
        return;
      }
      problem = (await response.text()) || response.statusText;
    } catch {
      problem = 'VS Code did not answer. Is it still running?';
    }
    if (current !== attempt) {
      return;
    }
    status.textContent = 'Could not open ' + label + ': ' + problem;
    showFallback(reference);
  }

  // A link into a tab that already shows this page only changes the fragment, which doesn't reload the page
  window.addEventListener('hashchange', openFromFragment);
  openFromFragment();
})();
