import * as vscode from 'vscode';
import { MarkdownPeek } from './MarkdownPeek';
import { ReferenceParser, ParsedReference } from './ReferenceParser';
import { ReferenceUtils } from './ReferenceUtils';

// The few markdown-it shapes this plugin touches; VS Code passes its own markdown-it instance.
interface Token {
  type: string;
  attrs: [string, string][] | null;
  content: string;
  markup: string;
  attrGet(name: string): string | null;
  attrSet(name: string, value: string): void;
  attrJoin(name: string, value: string): void;
}

interface InlineState {
  src: string;
  pos: number;
  posMax: number;
  linkLevel?: number;
  push(type: string, tag: string, nesting: number): Token;
}

interface Renderer {
  renderToken(tokens: Token[], idx: number, options: unknown): string;
}

type RenderRule = (tokens: Token[], idx: number, options: unknown, env: { currentDocument?: vscode.Uri } | undefined, self: Renderer) => string;

interface MarkdownIt {
  inline: { ruler: { push(name: string, rule: (state: InlineState, silent: boolean) => boolean): void } };
  renderer: { rules: Record<string, RenderRule | undefined> };
  utils: { escapeHtml(text: string): string };
  options: { highlight?: ((code: string, lang: string, attrs: string) => string) | null };
}

export interface OpenRequest {
  reference: string;
  from?: string;
  /** Set by media/markdown-preview.js on Cmd/Ctrl+click: open in a new split instead of the usual one. */
  split?: 'new';
}

/**
 * Makes references clickable in the built-in Markdown preview.
 *
 * The preview webview does not run `command:` links, so each reference link points at
 * `vscode://<extension id>/open?<json>`, which VS Code routes to this extension's URI handler.
 * Each link is wrapped in `.incontext-reference` with a hover peek of the referenced code
 * (styled and positioned by media/markdown-preview.css and .js).
 */
export class MarkdownPreview {
  static readonly OPEN_PATH = '/open';
  // A bare reference must start a word, so e-mail addresses and the like stay text
  private static readonly REFERENCE_BOUNDARY = /[\s([{<>"'`*_~]/;

  static extendMarkdownIt(md: MarkdownIt, extensionId: string): MarkdownIt {
    md.inline.ruler.push('incontext_reference', MarkdownPreview.bareReferenceRule);
    const renderer = {
      escapeHtml: (text: string) => md.utils.escapeHtml(text),
      highlight: (code: string, lang: string, attrs: string) => md.options.highlight?.(code, lang, attrs) ?? '',
    };
    // Peeks waiting to be written after their link's closing tag, keyed by the link_close token
    const pendingPeeks = new WeakMap<Token, string>();

    // `@project/path/file.ts:L34:43` written as inline code
    const renderCodeInline = md.renderer.rules.code_inline;
    md.renderer.rules.code_inline = (tokens, idx, options, env, self) => {
      const html = renderCodeInline ? renderCodeInline(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
      const reference = tokens[idx].content.trim();
      const parsed = MarkdownPreview.isBareReference(reference) ? ReferenceParser.parse(reference) : undefined;
      if (!parsed) {
        return html;
      }
      const from = env?.currentDocument;
      const openUri = md.utils.escapeHtml(MarkdownPreview.createOpenUri(extensionId, { reference, from: from?.toString() }));
      const peek = MarkdownPreview.renderPeek(renderer, reference, parsed, from);
      if (!peek) {
        return `<a class="incontext-link" href="${openUri}" data-href="${openUri}" title="${md.utils.escapeHtml(MarkdownPreview.describe(parsed))}">${html}</a>`;
      }
      return `<span class="incontext-reference"><a class="incontext-link" href="${openUri}" data-href="${openUri}">${html}</a>${peek}</span>`;
    };

    const renderLinkOpen = md.renderer.rules.link_open;
    md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
      const render = () => renderLinkOpen ? renderLinkOpen(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
      const token = tokens[idx];
      const href = token.attrGet('href');
      const parsed = href ? ReferenceParser.parseMarkdownLinkTarget(href) : undefined;
      const from = env?.currentDocument;
      if (!href || !parsed || (!parsed.isWorkspaceReference && !from && !parsed.path.startsWith('/'))) {
        return render();
      }
      const openUri = MarkdownPreview.createOpenUri(extensionId, { reference: href, from: from?.toString() });
      const peek = MarkdownPreview.renderPeek(renderer, href, parsed, from);
      const linkClose = MarkdownPreview.findLinkClose(tokens, idx);
      // Tokens are cached between renders, so the rewrite is undone once this link is rendered
      const originalAttrs = token.attrs && token.attrs.map(([name, value]) => [name, value] as [string, string]);
      token.attrSet('href', openUri);
      // The preview opens a link's data-href when it has one (set from the original href)
      token.attrSet('data-href', openUri);
      token.attrJoin('class', 'incontext-link');
      if (peek && linkClose) {
        pendingPeeks.set(linkClose, peek);
      } else if (!token.attrGet('title')) {
        token.attrSet('title', MarkdownPreview.describe(parsed));
      }
      try {
        return (peek && linkClose ? '<span class="incontext-reference">' : '') + render();
      } finally {
        token.attrs = originalAttrs;
      }
    };

    const renderLinkClose = md.renderer.rules.link_close;
    md.renderer.rules.link_close = (tokens, idx, options, env, self) => {
      const html = renderLinkClose ? renderLinkClose(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
      const peek = pendingPeeks.get(tokens[idx]);
      if (peek === undefined) {
        return html;
      }
      pendingPeeks.delete(tokens[idx]);
      return `${html}${peek}</span>`;
    };
    return md;
  }

  static createOpenUri(extensionId: string, request: OpenRequest): string {
    return `${vscode.env.uriScheme}://${extensionId}${MarkdownPreview.OPEN_PATH}?${encodeURIComponent(JSON.stringify(request))}`;
  }

  static parseOpenUri(uri: vscode.Uri): OpenRequest | undefined {
    // VS Code hands the query over decoded; decode again in case a caller encoded it twice
    for (const query of [uri.query, MarkdownPreview.safeDecode(uri.query)]) {
      try {
        const request = JSON.parse(query);
        if (typeof request?.reference === 'string') {
          return {
            reference: request.reference,
            from: typeof request.from === 'string' ? request.from : undefined,
            split: request.split === 'new' ? 'new' : undefined,
          };
        }
      } catch {
        // try the next form
      }
    }
    return undefined;
  }

  /** Turns `@project/path/file.ts:L34:43` in markdown text into a link. */
  private static bareReferenceRule(state: InlineState, silent: boolean): boolean {
    const start = state.pos;
    if (state.src.charCodeAt(start) !== 0x40 /* @ */ || (state.linkLevel ?? 0) > 0) {
      return false;
    }
    if (start > 0 && !MarkdownPreview.REFERENCE_BOUNDARY.test(state.src[start - 1])) {
      return false;
    }
    const match = /^@[^\s@]+/.exec(state.src.slice(start, state.posMax));
    if (!match) {
      return false;
    }
    const reference = ReferenceParser.trimReference(match[0]);
    if (!MarkdownPreview.isBareReference(reference)) {
      return false;
    }
    if (!silent) {
      const linkOpen = state.push('link_open', 'a', 1);
      linkOpen.attrs = [['href', reference]];
      linkOpen.markup = 'incontext';
      state.push('text', '', 0).content = reference;
      state.push('link_close', 'a', -1).markup = 'incontext';
    }
    state.pos += reference.length;
    return true;
  }

  private static isBareReference(text: string): boolean {
    // Require a path so `@mentions` stay plain text
    return /^@[^\s@]+$/.test(text) && text.includes('/') && ReferenceParser.trimReference(text) === text && ReferenceParser.parse(text) !== undefined;
  }

  private static renderPeek(renderer: Parameters<typeof MarkdownPeek.render>[0], reference: string, parsed: ParsedReference, from?: vscode.Uri): string | undefined {
    const target = ReferenceUtils.resolveReference(parsed, from);
    return target && MarkdownPeek.render(renderer, reference, parsed, target);
  }

  private static findLinkClose(tokens: Token[], linkOpenIndex: number): Token | undefined {
    // Links cannot nest, so the first link_close after a link_open closes it
    for (let i = linkOpenIndex + 1; i < tokens.length; i++) {
      if (tokens[i].type === 'link_close') {
        return tokens[i];
      }
    }
    return undefined;
  }

  private static describe(parsed: ParsedReference): string {
    const lines = ReferenceParser.describeLines(parsed);
    return `Open ${parsed.path}${lines ? ` (${lines})` : ''}`;
  }

  private static safeDecode(value: string): string {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
}
