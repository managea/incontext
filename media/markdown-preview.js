// Keeps incontext reference peeks inside the Markdown preview's viewport:
// shown below the reference, or above it when there is no room below.
(function () {
  const MARGIN = 8;

  function position(reference) {
    const link = reference.querySelector(':scope > a');
    const peek = reference.querySelector(':scope > .incontext-peek');
    if (!link || !peek) {
      return;
    }
    // The first line box of the link, in case the reference wraps across lines
    const anchor = link.getClientRects()[0] || link.getBoundingClientRect();
    peek.style.position = 'fixed';
    peek.style.left = '0px';
    peek.style.top = '0px';
    const box = peek.getBoundingClientRect();
    const fitsBelow = anchor.bottom + box.height <= window.innerHeight - MARGIN;
    const fitsAbove = anchor.top - box.height >= MARGIN;
    const top = fitsBelow || !fitsAbove ? anchor.bottom : anchor.top - box.height;
    const left = Math.max(MARGIN, Math.min(anchor.left, window.innerWidth - box.width - MARGIN));
    peek.style.left = `${left}px`;
    peek.style.top = `${top}px`;
  }

  document.addEventListener('mouseover', event => {
    const reference = event.target instanceof Element ? event.target.closest('.incontext-reference') : null;
    if (reference && !(event.relatedTarget instanceof Node && reference.contains(event.relatedTarget))) {
      position(reference);
    }
  });

  // Typing in the markdown re-renders the preview, which drops the position of an open peek
  window.addEventListener('vscode.markdown.updateContent', () => {
    document.querySelectorAll('.incontext-reference:hover').forEach(position);
  });

  // Cmd/Ctrl+click opens the reference in a new split. VS Code passes only the link to the extension, so for this
  // click the link's payload (vscode://<extension>/open?<json>) gets `split: "new"`. Window capture runs before
  // the preview's own click handler (which reads data-href) and VS Code's (which reads href).
  window.addEventListener('click', event => {
    const link = (event.metaKey || event.ctrlKey) && event.target instanceof Element ? event.target.closest('a.incontext-link') : null;
    const href = link && link.getAttribute('href');
    const queryStart = href ? href.indexOf('?') : -1;
    if (queryStart < 0) {
      return;
    }
    let request;
    try {
      request = JSON.parse(decodeURIComponent(href.slice(queryStart + 1)));
    } catch {
      return;
    }
    const dataHref = link.getAttribute('data-href');
    const newSplitHref = href.slice(0, queryStart + 1) + encodeURIComponent(JSON.stringify({ ...request, split: 'new' }));
    link.setAttribute('href', newSplitHref);
    link.setAttribute('data-href', newSplitHref);
    setTimeout(() => {
      link.setAttribute('href', href);
      if (dataHref !== null) {
        link.setAttribute('data-href', dataHref);
      }
    });
  }, true);
})();
