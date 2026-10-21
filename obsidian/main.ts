import { syntaxTree } from '@codemirror/language';
import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { Plugin } from 'obsidian';
import { ReferenceParser } from '../src/ReferenceParser';

const VSCODE_PREFIX = 'vscode://managea.incontext/';
// Set on what this plugin turns into a link, in the editor and in Reading view
const REFERENCE_ATTRIBUTE = 'data-incontext-reference';

/**
 * Opens incontext references from Obsidian in VS Code, as vscode://managea.incontext/@project/path:L34:43 links.
 * - References in notes, such as @project/src/file.ts:L34:43, become links in the editor and in Reading view.
 * - Link-server links (http://localhost:<port>/open#@...) skip the browser Obsidian would open them in. Mermaid
 *   diagrams need them: Obsidian's Mermaid drops vscode: links, so a diagram's `click` lines can't use those.
 */
export default class InContextLinks extends Plugin {
  // A link-server link, and the reference after its `#`
  private static readonly LINK_SERVER_LINK = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\/open#(@[^\s@]+)$/;

  onload(): void {
    this.registerEditorExtension(ViewPlugin.fromClass(ReferenceDecorations, { decorations: plugin => plugin.decorations }));
    this.registerMarkdownPostProcessor(element => InContextLinks.linkReferences(element));
    this.watch(document);
    this.registerEvent(this.app.workspace.on('window-open', (_, win) => this.watch(win.document)));
  }

  private watch(doc: Document): void {
    // Capture phase, so the click is handled before Obsidian opens the link (an http link in the browser)
    this.registerDomEvent(doc, 'click', event => InContextLinks.open(event), { capture: true });
  }

  private static open(event: MouseEvent): void {
    const reference = event.button === 0 ? InContextLinks.referenceAt(event.target) : undefined;
    if (reference) {
      event.preventDefault();
      event.stopPropagation();
      window.open(VSCODE_PREFIX + reference);
    }
  }

  /**
   * The reference behind a click: one this plugin linked, or a link's target that is a link-server link or a
   * reference itself, such as a Mermaid `click` line's.
   */
  private static referenceAt(target: EventTarget | null): string | undefined {
    // Duck-typed, since a pop-out window's elements aren't instances of this window's Element
    const element = target as Element | null;
    if (typeof element?.closest !== 'function') {
      return undefined;
    }
    const linked = element.closest(`[${REFERENCE_ATTRIBUTE}]`)?.getAttribute(REFERENCE_ATTRIBUTE);
    if (linked) {
      return linked;
    }
    // A Mermaid box is an SVG <a>, which may keep its target in xlink:href
    const anchor = element.closest('a');
    const href = anchor?.getAttribute('href') ?? anchor?.getAttribute('xlink:href') ?? '';
    const reference = InContextLinks.LINK_SERVER_LINK.exec(href)?.[1] ?? href;
    return InContextLinks.isReference(reference) ? reference : undefined;
  }

  private static isReference(text: string): boolean {
    const matches = ReferenceParser.findStandaloneReferences(text);
    return matches.length === 1 && matches[0].reference === text;
  }

  /** Turns references in a section of Reading view into links. Text in links, code blocks and diagrams stays as it is. */
  private static linkReferences(element: HTMLElement): void {
    const doc = element.ownerDocument;
    const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode: node => node.parentElement?.closest('a, pre, svg') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    const texts: Text[] = [];
    while (walker.nextNode()) {
      texts.push(walker.currentNode as Text);
    }
    for (const text of texts) {
      const matches = ReferenceParser.findStandaloneReferences(text.data);
      if (matches.length === 0) {
        continue;
      }
      const parts: (string | Node)[] = [];
      let end = 0;
      for (const match of matches) {
        const link = doc.createElement('a');
        link.textContent = match.reference;
        link.href = VSCODE_PREFIX + match.reference;
        link.setAttribute(REFERENCE_ATTRIBUTE, match.reference);
        parts.push(text.data.slice(end, match.start), link);
        end = match.end;
      }
      parts.push(text.data.slice(end));
      text.replaceWith(...parts);
    }
  }
}

/** Marks references in the editor (Live Preview and Source mode) as links, except in fenced code blocks. */
class ReferenceDecorations {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = ReferenceDecorations.build(view);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
      this.decorations = ReferenceDecorations.build(update.view);
    }
  }

  private static build(view: EditorView): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    const { doc } = view.state;
    const tree = syntaxTree(view.state);
    let lastLine = 0;
    for (const { from, to } of view.visibleRanges) {
      for (let number = Math.max(doc.lineAt(from).number, lastLine + 1); number <= doc.lineAt(to).number; number++) {
        const line = doc.line(number);
        for (const match of ReferenceParser.findStandaloneReferences(line.text)) {
          const start = line.from + match.start;
          // Obsidian's Markdown parser names the text of a fenced code block hmd-codeblock
          if (!tree.resolveInner(start, 1).name.includes('hmd-codeblock')) {
            builder.add(start, line.from + match.end, Decoration.mark({
              class: 'cm-link incontext-reference',
              attributes: { [REFERENCE_ATTRIBUTE]: match.reference },
            }));
          }
        }
        lastLine = number;
      }
    }
    return builder.finish();
  }
}
