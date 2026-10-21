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

  // A link's payload (vscode://<extension>/open?<json>) with `split: "new"`, or undefined if it has none
  function withNewSplit(href) {
    const queryStart = href.indexOf('?');
    if (queryStart < 0) {
      return undefined;
    }
    try {
      const request = JSON.parse(decodeURIComponent(href.slice(queryStart + 1)));
      return href.slice(0, queryStart + 1) + encodeURIComponent(JSON.stringify({ ...request, split: 'new' }));
    } catch {
      return undefined;
    }
  }

  // Cmd/Ctrl+click opens the reference in a new split. VS Code passes only the link to the extension, so for this
  // click the link's payload gets `split: "new"`. Window capture runs before the preview's own click handler
  // (which reads data-href) and VS Code's (which reads href).
  window.addEventListener('click', event => {
    const link = (event.metaKey || event.ctrlKey) && event.target instanceof Element ? event.target.closest('a.incontext-link') : null;
    const href = link && link.getAttribute('href');
    const newSplitHref = href && withNewSplit(href);
    if (!newSplitHref) {
      return;
    }
    const dataHref = link.getAttribute('data-href');
    link.setAttribute('href', newSplitHref);
    link.setAttribute('data-href', newSplitHref);
    setTimeout(() => {
      link.setAttribute('href', href);
      if (dataHref !== null) {
        link.setAttribute('data-href', dataHref);
      }
    });
  }, true);

  // Mermaid draws a diagram's links as SVG links, which the preview's own click and double-click handling don't
  // treat as links: a click left the preview as an unsigned link-server link that opened over the preview, and a
  // double-click switched to the editor. For a link to a reference (a link-server link or a bare @ reference), the
  // click now carries the signed link the preview plugin wrote beside the diagram (src/MarkdownPreview.ts), so the
  // reference opens beside the preview like any other, and in a new split on Cmd/Ctrl+click.
  const XLINK = 'http://www.w3.org/1999/xlink';

  function diagramReference(event) {
    // The composed path also reaches a diagram drawn inside a shadow root
    const link = event.composedPath().find(node => node instanceof SVGAElement);
    const href = link ? link.getAttribute('href') ?? link.getAttributeNS(XLINK, 'href') ?? '' : '';
    const match = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\/open(?:#|#35;)(@\S+)$/.exec(href);
    const reference = match ? match[1] : href.startsWith('@') ? href : undefined;
    return reference ? { link, reference } : undefined;
  }

  function signedLink(reference) {
    for (const holder of document.querySelectorAll('.incontext-diagram-links')) {
      try {
        const href = JSON.parse(holder.dataset.links)[reference];
        if (typeof href === 'string') {
          return href;
        }
      } catch {
        // try the next diagram's links
      }
    }
    return undefined;
  }

  window.addEventListener('click', event => {
    const diagram = diagramReference(event);
    const href = diagram && signedLink(diagram.reference);
    if (!href) {
      return;
    }
    if (event.detail > 1) {
      // The first click of a double-click has already opened the reference
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const { link } = diagram;
    const original = link.getAttribute('href');
    // An SVG link's href wins over the xlink:href Mermaid writes; VS Code reads it after this capture handler
    link.setAttribute('href', (event.metaKey || event.ctrlKey ? withNewSplit(href) : undefined) ?? href);
    setTimeout(() => original === null ? link.removeAttribute('href') : link.setAttribute('href', original));
  }, true);

  // The preview switches to the editor on a double-click anywhere but on a link
  window.addEventListener('dblclick', event => {
    if (diagramReference(event)) {
      event.stopPropagation();
    }
  }, true);
})();
