import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AiInstructions, AiTarget, AiToolId, RemoveOutcome, WriteOutcome } from './AiInstructions';
import { LinkService } from './LinkService';

/** Arguments for running the commands without asking, e.g. from tests or other extensions. */
export interface AiInstructionsArgs {
  tools?: AiToolId[];
}

export interface AiInstructionsResult {
  tool: AiToolId;
  label: string;
  file: string;
  outcome: WriteOutcome | RemoveOutcome | 'skipped';
}

/**
 * The commands that install the citation instruction (media/ai-instructions.md) into Claude Code, GitHub Copilot
 * and Codex, and remove it again, plus the offer to update it when the link server's port changes.
 * Run with `{ tools }`, they don't ask anything and skip files reached through a symlink.
 */
export class AiInstructionsCommands {
  static readonly SET_UP = 'incontext.setUpAiInstructions';
  static readonly REMOVE = 'incontext.removeAiInstructions';

  static register(context: vscode.ExtensionContext): vscode.Disposable[] {
    const mediaFolder = vscode.Uri.joinPath(context.extensionUri, 'media').fsPath;
    return [
      vscode.commands.registerCommand(AiInstructionsCommands.SET_UP, (args?: AiInstructionsArgs) => AiInstructionsCommands.setUp(mediaFolder, args)),
      vscode.commands.registerCommand(AiInstructionsCommands.REMOVE, (args?: AiInstructionsArgs) => AiInstructionsCommands.remove(args)),
      vscode.workspace.onDidChangeConfiguration(event => {
        // Every window sees the change; only the one it was made in offers the update
        if (event.affectsConfiguration('incontext.linkServer.port') && vscode.window.state.focused) {
          void AiInstructionsCommands.offerPortUpdate(mediaFolder);
        }
      }),
    ];
  }

  private static async setUp(mediaFolder: string, args?: AiInstructionsArgs): Promise<AiInstructionsResult[]> {
    const port = AiInstructionsCommands.port();
    const targets = AiInstructions.targets();
    let chosen: AiTarget[];
    if (args?.tools) {
      chosen = targets.filter(target => args.tools!.includes(target.tool));
    } else {
      const picked = await vscode.window.showQuickPick(targets.map(target => {
        const state = AiInstructions.state(target);
        return {
          label: target.label,
          description: AiInstructionsCommands.display(target.file),
          detail: [
            target.ownsFile ? 'Writes a file of its own' : `Adds a marked block; the rest of ${path.basename(target.file)} stays as it is`,
            state.installed ? (state.port === port ? 'Set up' : `Set up for port ${state.port}, will be updated`) : '',
            !state.installed && !fs.existsSync(target.toolFolder) ? `${AiInstructionsCommands.display(target.toolFolder)} not found` : '',
          ].filter(Boolean).join(' · '),
          picked: state.installed || fs.existsSync(target.toolFolder),
          target,
        };
      }), {
        canPickMany: true,
        title: 'Set Up AI Assistant Instructions',
        placeHolder: 'Pick the AI tools that should cite code as incontext links (they read these files)',
      });
      if (!picked) {
        return [];
      }
      chosen = picked.map(item => item.target);
    }
    return AiInstructionsCommands.write(chosen, AiInstructionsCommands.instructions(mediaFolder, port), !args?.tools);
  }

  private static async remove(args?: AiInstructionsArgs): Promise<AiInstructionsResult[]> {
    const installed = AiInstructions.targets().filter(target => AiInstructions.state(target).installed);
    let chosen: AiTarget[];
    if (args?.tools) {
      chosen = installed.filter(target => args.tools!.includes(target.tool));
    } else {
      if (installed.length === 0) {
        vscode.window.showInformationMessage('There are no incontext AI assistant instructions to remove.');
        return [];
      }
      const picked = await vscode.window.showQuickPick(installed.map(target => ({
        label: target.label,
        description: AiInstructionsCommands.display(target.file),
        detail: target.ownsFile ? 'Deletes the file' : `Removes the marked block; the rest of ${path.basename(target.file)} stays as it is`,
        picked: true,
        target,
      })), { canPickMany: true, title: 'Remove AI Assistant Instructions' });
      if (!picked) {
        return [];
      }
      chosen = picked.map(item => item.target);
    }
    const results: AiInstructionsResult[] = [];
    for (const target of chosen) {
      const outcome = await AiInstructionsCommands.mayChange(target, !args?.tools) ? AiInstructions.remove(target) : 'skipped';
      results.push({ tool: target.tool, label: target.label, file: target.file, outcome });
    }
    AiInstructionsCommands.report('Removed', results, 'removed');
    return results;
  }

  private static async offerPortUpdate(mediaFolder: string): Promise<void> {
    const port = AiInstructionsCommands.port();
    const stale = AiInstructions.targets().filter(target => {
      const state = AiInstructions.state(target);
      return state.installed && state.port !== port;
    });
    if (stale.length === 0) {
      return;
    }
    const answer = await vscode.window.showInformationMessage(
      `The AI assistant instructions incontext wrote for ${stale.map(target => target.label).join(', ')} still link to the old port. Update them to port ${port}?`,
      'Update');
    if (answer === 'Update') {
      await AiInstructionsCommands.write(stale, AiInstructionsCommands.instructions(mediaFolder, AiInstructionsCommands.port()), true);
    }
  }

  private static async write(targets: AiTarget[], instructions: string, interactive: boolean): Promise<AiInstructionsResult[]> {
    const results: AiInstructionsResult[] = [];
    for (const target of targets) {
      const outcome = await AiInstructionsCommands.mayChange(target, interactive) ? AiInstructions.write(target, instructions) : 'skipped';
      results.push({ tool: target.tool, label: target.label, file: target.file, outcome });
    }
    AiInstructionsCommands.report('Set up', results, 'written');
    return results;
  }

  /** Whether `target`'s file may be changed: when a symlink leads elsewhere, only if the user says so. */
  private static async mayChange(target: AiTarget, interactive: boolean): Promise<boolean> {
    const links = AiInstructions.symlinksOnPath(target);
    if (links.length === 0) {
      return true;
    }
    if (!interactive) {
      return false;
    }
    const where = links.map(link => `${AiInstructionsCommands.display(link.link)} is a symlink to ${AiInstructionsCommands.display(link.pointsTo)}.`).join(' ');
    const answer = await vscode.window.showWarningMessage(
      `${where} Change ${target.label}'s instructions there anyway?`,
      { modal: true, detail: `File: ${AiInstructionsCommands.display(target.file)}` },
      'Change It');
    return answer === 'Change It';
  }

  private static report(verb: string, results: AiInstructionsResult[], done: WriteOutcome | RemoveOutcome): void {
    if (results.length === 0) {
      return;
    }
    const why: Record<string, string> = {
      unchanged: 'already up to date',
      absent: 'nothing to remove',
      skipped: 'skipped, a symlink leads elsewhere',
      malformed: `left alone: its ${AiInstructions.START} markers are broken`,
      foreign: 'left alone: a file of that name already exists and is not incontext\'s',
    };
    const lines = results.map(result => `${result.label}: ${result.outcome === done ? AiInstructionsCommands.display(result.file) : why[result.outcome]}`);
    const failed = results.some(result => result.outcome === 'malformed' || result.outcome === 'foreign');
    const message = `${verb} incontext AI assistant instructions. ${lines.join('; ')}`;
    const changed = results.filter(result => result.outcome === 'written').map(result => result.file);
    const buttons = changed.length > 0 ? ['Open Files'] : [];
    const shown = failed ? vscode.window.showWarningMessage(message, ...buttons) : vscode.window.showInformationMessage(message, ...buttons);
    void shown.then(answer => {
      if (answer === 'Open Files') {
        changed.forEach(file => void vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false }));
      }
    });
  }

  private static instructions(mediaFolder: string, port: number): string {
    return AiInstructions.render(AiInstructions.loadTemplate(mediaFolder), port, vscode.env.uriScheme);
  }

  private static port(): number {
    return vscode.workspace.getConfiguration('incontext.linkServer').get<number>('port', LinkService.DEFAULT_PORT);
  }

  /** A path as the user knows it, with ~ for the home folder. */
  private static display(file: string): string {
    const home = os.homedir();
    return file.startsWith(home + path.sep) ? `~${file.substring(home.length)}` : file;
  }
}
