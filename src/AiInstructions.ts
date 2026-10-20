import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type AiToolId = 'claude' | 'copilot' | 'codex';

/** Where an AI tool reads the user's own instructions, and how incontext writes its instruction there. */
export interface AiTarget {
  tool: AiToolId;
  label: string;
  /** The file incontext writes. For Codex, the AGENTS.md (or AGENTS.override.md) that gets the marked block. */
  file: string;
  /** Whether incontext owns the whole file, or only a marked block in a file the user owns. */
  ownsFile: boolean;
  /** The tool's settings folder, to tell whether the tool is used on this computer. */
  toolFolder: string;
}

export interface AiTargetState {
  /** Whether the file holds incontext's block. */
  installed: boolean;
  /** The link server port the block links to. */
  port?: number;
  /** A start marker without an end marker (or the reverse): the file is left alone. */
  malformed?: boolean;
  /** A file incontext would own exists but isn't incontext's: it is left alone. */
  foreign?: boolean;
}

export type WriteOutcome = 'written' | 'unchanged' | 'malformed' | 'foreign';
export type RemoveOutcome = 'removed' | 'absent' | 'malformed';

/**
 * The instruction that tells AI tools (Claude Code, GitHub Copilot, Codex) to cite code as incontext links,
 * kept in one template (media/ai-instructions.md) and written into each tool's user-level instructions.
 * Kept free of the vscode API so it can be tested on its own.
 *
 * Claude Code and Copilot read every file in their instruction folders, so incontext writes a file of its own for
 * each. Codex reads a single AGENTS.md, so incontext keeps its text between START and END markers there and never
 * changes the rest of the file.
 */
export class AiInstructions {
  static readonly START = '<!-- incontext-references:start -->';
  static readonly END = '<!-- incontext-references:end -->';
  static readonly NOTE = '<!-- Written by the incontext VS Code extension. "InContext: Set Up AI Assistant Instructions" updates this block and "InContext: Remove AI Assistant Instructions" removes it; edits inside it are replaced. -->';
  // The README's copy sits in a list item, so its markers are indented like the item's text
  private static readonly README_START = '  <!-- ai-instructions:start (generated from media/ai-instructions.md by npm run sync-readme) -->';
  private static readonly README_END = '  <!-- ai-instructions:end -->';

  /** The files each tool reads, for the user whose home folder is `home`. */
  static targets(home = os.homedir(), codexHome = process.env.CODEX_HOME): AiTarget[] {
    const codex = codexHome || path.join(home, '.codex');
    // Codex reads AGENTS.override.md instead of AGENTS.md when there is one
    const override = path.join(codex, 'AGENTS.override.md');
    return [
      { tool: 'claude', label: 'Claude Code', file: path.join(home, '.claude', 'rules', 'incontext-references.md'), ownsFile: true, toolFolder: path.join(home, '.claude') },
      { tool: 'copilot', label: 'GitHub Copilot', file: path.join(home, '.copilot', 'instructions', 'incontext-references.instructions.md'), ownsFile: true, toolFolder: path.join(home, '.copilot') },
      { tool: 'codex', label: 'Codex', file: fs.existsSync(override) ? override : path.join(codex, 'AGENTS.md'), ownsFile: false, toolFolder: codex },
    ];
  }

  static loadTemplate(mediaFolder: string): string {
    return fs.readFileSync(path.join(mediaFolder, 'ai-instructions.md'), 'utf8');
  }

  /** The instruction for links to the link server on `port`, opening in the VS Code whose URI scheme is `uriScheme`. */
  static render(template: string, port: number, uriScheme: string): string {
    return template.replace(/\{\{PORT\}\}/g, String(port)).replace(/\{\{URI_SCHEME\}\}/g, uriScheme).trimEnd();
  }

  static block(instructions: string): string {
    return [AiInstructions.START, AiInstructions.NOTE, '', instructions, AiInstructions.END].join('\n');
  }

  /** What incontext writes to `target`'s file, given the file's current text (undefined when it doesn't exist). */
  static content(target: AiTarget, instructions: string, current: string | undefined): string | undefined {
    const block = AiInstructions.block(instructions);
    if (!target.ownsFile) {
      return AiInstructions.withBlock(current ?? '', block);
    }
    // VS Code applies an instructions file only with applyTo (or when attached by hand)
    const frontMatter = target.tool === 'copilot' ? '---\napplyTo: "**"\ndescription: "Cite workspace code as clickable incontext links"\n---\n\n' : '';
    return `${frontMatter}${block}\n`;
  }

  /** `text` with incontext's block replaced by `block`, or with `block` appended. Undefined when the markers are broken. */
  static withBlock(text: string, block: string): string | undefined {
    const span = AiInstructions.findBlock(text);
    if (span === null) {
      return undefined;
    }
    if (span) {
      return text.substring(0, span.start) + block + text.substring(span.end);
    }
    const separator = text === '' ? '' : text.endsWith('\n') ? '\n' : '\n\n';
    return `${text}${separator}${block}\n`;
  }

  /** `text` without incontext's block, undoing the blank line withBlock put before it. Undefined when the markers are broken. */
  static withoutBlock(text: string): string | undefined {
    const span = AiInstructions.findBlock(text);
    if (span === null) {
      return undefined;
    }
    if (!span) {
      return text;
    }
    let before = text.substring(0, span.start);
    let after = text.substring(span.end);
    if (after.startsWith('\n')) {
      after = after.substring(1);
    }
    if (before.endsWith('\n\n')) {
      before = before.substring(0, before.length - 1);
    }
    return before + after;
  }

  static state(target: AiTarget): AiTargetState {
    const text = AiInstructions.read(target.file);
    if (text === undefined) {
      return { installed: false };
    }
    const span = AiInstructions.findBlock(text);
    if (span === null) {
      return { installed: false, malformed: true };
    }
    if (!span) {
      return { installed: false, foreign: target.ownsFile };
    }
    const port = /http:\/\/localhost:(\d+)\/open/.exec(text.substring(span.start, span.end))?.[1];
    return { installed: true, port: port ? Number(port) : undefined };
  }

  /** Writes the instruction into `target`'s file, creating its folder if needed. */
  static write(target: AiTarget, instructions: string): WriteOutcome {
    const state = AiInstructions.state(target);
    if (state.malformed || state.foreign) {
      return state.malformed ? 'malformed' : 'foreign';
    }
    const current = AiInstructions.read(target.file);
    const content = AiInstructions.content(target, instructions, current);
    if (content === undefined) {
      return 'malformed';
    }
    if (content === current) {
      return 'unchanged';
    }
    fs.mkdirSync(path.dirname(target.file), { recursive: true });
    fs.writeFileSync(target.file, content);
    return 'written';
  }

  /** Removes what write wrote: incontext's own file, or its block from the user's file. */
  static remove(target: AiTarget): RemoveOutcome {
    const current = AiInstructions.read(target.file);
    const state = AiInstructions.state(target);
    if (current === undefined || !state.installed) {
      return state.malformed ? 'malformed' : 'absent';
    }
    const rest = target.ownsFile ? '' : AiInstructions.withoutBlock(current);
    if (rest === undefined) {
      return 'malformed';
    }
    if (rest === '') {
      fs.rmSync(target.file, { force: true });
    } else {
      fs.writeFileSync(target.file, rest);
    }
    return 'removed';
  }

  /** The symlinks on the way to `target`'s file, from its tool folder down, with where each points. */
  static symlinksOnPath(target: AiTarget): { link: string; pointsTo: string }[] {
    const links: { link: string; pointsTo: string }[] = [];
    const stop = path.dirname(path.resolve(target.toolFolder));
    const below = stop.endsWith(path.sep) ? stop : stop + path.sep;
    for (let current = path.resolve(target.file); current.startsWith(below); current = path.dirname(current)) {
      try {
        if (fs.lstatSync(current).isSymbolicLink()) {
          links.unshift({ link: current, pointsTo: path.resolve(path.dirname(current), fs.readlinkSync(current)) });
        }
      } catch {
        // doesn't exist (yet)
      }
    }
    return links;
  }

  /** The instruction as the README shows it: with the default port, in a fenced block inside a list item. */
  static readmeBlock(root: string): string {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const port: number = manifest.contributes.configuration.properties['incontext.linkServer.port'].default;
    const instructions = AiInstructions.render(AiInstructions.loadTemplate(path.join(root, 'media')), port, 'vscode');
    const lines = ['```markdown', ...instructions.split('\n'), '```'].map(line => line ? `  ${line}` : '');
    return [AiInstructions.README_START, ...lines, AiInstructions.README_END].join('\n');
  }

  /** The README's copy of the instruction, between its markers. */
  static readmeCopy(readme: string): string | undefined {
    const start = readme.indexOf(AiInstructions.README_START);
    const end = readme.indexOf(AiInstructions.README_END);
    return start >= 0 && end > start ? readme.substring(start, end + AiInstructions.README_END.length) : undefined;
  }

  /** Copies the template into the README (`npm run sync-readme`). Returns whether the README changed. */
  static syncReadme(root: string): boolean {
    const file = path.join(root, 'README.md');
    const readme = fs.readFileSync(file, 'utf8');
    const copy = AiInstructions.readmeCopy(readme);
    if (copy === undefined) {
      throw new Error(`README.md has no ${AiInstructions.README_START} ... ${AiInstructions.README_END} section`);
    }
    const updated = readme.replace(copy, () => AiInstructions.readmeBlock(root));
    if (updated !== readme) {
      fs.writeFileSync(file, updated);
    }
    return updated !== readme;
  }

  /** The span of incontext's block, undefined when there is none, or null when its markers are broken. */
  private static findBlock(text: string): { start: number; end: number } | undefined | null {
    const start = text.indexOf(AiInstructions.START);
    const end = text.indexOf(AiInstructions.END);
    if (start < 0 && end < 0) {
      return undefined;
    }
    if (start < 0 || end < start || text.indexOf(AiInstructions.START, start + 1) >= 0) {
      return null;
    }
    return { start, end: end + AiInstructions.END.length };
  }

  private static read(file: string): string | undefined {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
  }
}
