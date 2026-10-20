export interface ParsedReference {
  /** True for `@project/path` references, which resolve against workspace folders by name. */
  isWorkspaceReference: boolean;
  path: string;
  isDirectory: boolean;
  /** 1-based first line, when the reference has a line suffix. */
  startLine?: number;
  /** 1-based last line, only when the suffix is a range. */
  endLine?: number;
  separator?: ':' | '#';
}

export interface ReferenceMatch {
  reference: string;
  start: number;
  end: number;
}

/**
 * Parses references in both the incontext style (`@project/file.ts:L34:43`)
 * and the markdown/GitHub style (`@project/file.ts#L34-L43`).
 */
export class ReferenceParser {
  static readonly REFERENCE_PATTERN = /@[^\s@]+/g;
  // path, then an optional `:L34`, `:L34:43`, `#L34`, `#L34-L43` or `#L34-43` (a `,col` after a line is ignored)
  private static readonly LINE_SUFFIX_PATTERN = /^(.+?)(?:([:#])L(\d+)(?:,\d+)?(?:[:-]L?(\d+)(?:,\d+)?)?)?$/;
  private static readonly TRAILING_PUNCTUATION = /[.,;:!?'"`*~)\]}>]$/;
  private static readonly SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;

  /** Finds `@` references in a line of text, without trailing punctuation such as the `)` of a markdown link. */
  static findReferences(text: string): ReferenceMatch[] {
    const matches: ReferenceMatch[] = [];
    const pattern = new RegExp(ReferenceParser.REFERENCE_PATTERN.source, 'g');
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const reference = ReferenceParser.trimReference(match[0]);
      if (reference.length > 1 && ReferenceParser.parse(reference)) {
        matches.push({ reference, start: match.index, end: match.index + reference.length });
      }
    }
    return matches;
  }

  static trimReference(candidate: string): string {
    let reference = candidate;
    while (reference.length > 1 && ReferenceParser.TRAILING_PUNCTUATION.test(reference)) {
      // Keep a closing parenthesis that belongs to the path, e.g. `@project/file(1).ts`
      if (reference.endsWith(')') && ReferenceParser.count(reference, '(') >= ReferenceParser.count(reference, ')')) {
        break;
      }
      reference = reference.slice(0, -1);
    }
    return reference;
  }

  static parse(reference: string): ParsedReference | undefined {
    const isWorkspaceReference = reference.startsWith('@');
    const body = isWorkspaceReference ? reference.substring(1) : reference;
    if (!body) {
      return undefined;
    }
    if (body.endsWith('/')) {
      return { isWorkspaceReference, path: body.substring(0, body.length - 1), isDirectory: true };
    }
    const match = body.match(ReferenceParser.LINE_SUFFIX_PATTERN);
    if (!match) {
      return undefined;
    }
    const [, path, separator, startLineStr, endLineStr] = match;
    const parsed: ParsedReference = { isWorkspaceReference, path, isDirectory: false };
    if (startLineStr) {
      parsed.separator = separator as ':' | '#';
      let startLine = Math.max(1, parseInt(startLineStr, 10));
      let endLine = endLineStr ? Math.max(1, parseInt(endLineStr, 10)) : undefined;
      if (endLine !== undefined && endLine < startLine) {
        [startLine, endLine] = [endLine, startLine];
      }
      parsed.startLine = startLine;
      parsed.endLine = endLine;
    }
    return parsed;
  }

  /**
   * Parses the target of a markdown link, e.g. the `...` in `[label](...)`.
   * Accepts `@` references, plus plain relative or workspace-rooted paths whose line suffix
   * VS Code cannot open by itself: a `#L34-L43` range or the `:L34:43` style.
   */
  static parseMarkdownLinkTarget(target: string): ParsedReference | undefined {
    const parsed = ReferenceParser.parse(target);
    if (!parsed || parsed.isWorkspaceReference) {
      return parsed;
    }
    if (parsed.isDirectory || !parsed.path || parsed.path.startsWith('#') || ReferenceParser.SCHEME_PATTERN.test(parsed.path)) {
      return undefined;
    }
    return parsed.separator === ':' || parsed.endLine !== undefined ? parsed : undefined;
  }

  static describeLines(parsed: ParsedReference): string {
    if (parsed.startLine === undefined) {
      return '';
    }
    return parsed.endLine !== undefined && parsed.endLine !== parsed.startLine
      ? `lines ${parsed.startLine}-${parsed.endLine}`
      : `line ${parsed.startLine}`;
  }

  private static count(text: string, char: string): number {
    return text.split(char).length - 1;
  }
}
