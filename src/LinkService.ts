import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { LaunchResult } from './LinkRequest';
import { LinkPage, LinkServer } from './LinkServer';
import { forwardToWindow, WindowEndpoint, WindowRegistry } from './LinkWindows';

interface Running {
  port: number;
  endpoint: WindowEndpoint;
  registry?: WindowRegistry;
  /** Set while this window owns the port. */
  server?: LinkServer;
  retry: NodeJS.Timeout;
  taking?: boolean;
  reportedBusy?: boolean;
}

/**
 * Opens references from links such as http://localhost:46266/open#@project/src/file.ts:L34:43, which the
 * Claude desktop app opens in its own Browser pane (see LinkServer).
 *
 * Every VS Code window runs this, but only one window can own the port: the first to start. It answers every link
 * and passes each one on to the window that has the reference's workspace folder (the most recently focused one if
 * several have it, or the most recently focused window if none has). The other windows try to take the port over
 * every few seconds, so links keep working after the owner closes.
 */
export class LinkService implements vscode.Disposable {
  static readonly DEFAULT_PORT = 46266;
  private static readonly RETRY_MS = 5000;
  private readonly id = crypto.randomUUID();
  private focusedAt = vscode.window.state.focused ? Date.now() : 0;
  private running?: Running;
  private disposed = false;
  private queue: Promise<void> = Promise.resolve();
  private readonly disposables: vscode.Disposable[] = [];

  /** `open` opens a reference in this window and resolves to whether it did; it shows its own errors. */
  constructor(private readonly page: LinkPage, private readonly open: (reference: string) => Promise<boolean>, private readonly log: vscode.LogOutputChannel) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('incontext.linkServer')) {
          this.restart();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.register()),
      vscode.window.onDidChangeWindowState(state => {
        if (state.focused) {
          this.focusedAt = Date.now();
          this.register();
        }
      }),
    );
    this.restart();
  }

  dispose(): void {
    this.disposed = true;
    this.disposables.forEach(disposable => disposable.dispose());
    // Removes this window from the registry right away; the servers close in the background
    void this.stop();
  }

  private restart(): void {
    if (this.disposed) {
      return;
    }
    this.queue = this.queue
      .then(() => this.stop())
      .then(() => this.start())
      .catch(error => this.log.error('Link server:', error));
  }

  private async start(): Promise<void> {
    const config = vscode.workspace.getConfiguration('incontext.linkServer');
    if (!config.get<boolean>('enabled', true)) {
      return;
    }
    if (vscode.env.remoteName) {
      // 127.0.0.1 would be the remote machine, and VS Code would offer to forward the port
      this.log.info('Link server: not started in a remote window');
      return;
    }
    const port = config.get<number>('port', LinkService.DEFAULT_PORT);
    const endpoint = new WindowEndpoint(reference => this.openHere(reference));
    await endpoint.listen();
    if (this.disposed) {
      await endpoint.close();
      return;
    }
    const registry = WindowRegistry.open(port);
    if (!registry) {
      this.log.warn('Link server: cannot set up the folder that lists VS Code windows, so links are opened by whichever window owns the port');
    }
    this.running = { port, endpoint, registry, retry: setInterval(() => void this.takePort(), LinkService.RETRY_MS) };
    this.register();
    await this.takePort();
  }

  private async stop(): Promise<void> {
    const running = this.running;
    if (!running) {
      return;
    }
    this.running = undefined;
    clearInterval(running.retry);
    try {
      running.registry?.remove(this.id);
    } catch {
      // the entry may be gone already
    }
    await Promise.all([running.server?.close(), running.endpoint.close()]);
  }

  /** Tries to listen on the shared port, which another window (or another program) may hold. */
  private async takePort(): Promise<void> {
    const running = this.running;
    if (!running || running.server || running.taking) {
      return;
    }
    const server = new LinkServer(this.page, reference => this.route(reference));
    running.taking = true;
    const listening = await server.listen(running.port);
    running.taking = false;
    if (!listening) {
      if (!running.reportedBusy) {
        running.reportedBusy = true;
        this.log.info(`Link server: port ${running.port} is in use, by another VS Code window or another program. The window that owns it opens links; this window takes over if it frees up.`);
      }
      return;
    }
    if (this.running !== running) {
      await server.close();
      return;
    }
    running.server = server;
    this.log.info(`Link server: opening links to http://localhost:${running.port}/open#@<folder>/<path>`);
  }

  /** Records this window in the registry, so the owner of the port can pass links on to it. */
  private register(): void {
    const running = this.running;
    if (!running?.registry) {
      return;
    }
    try {
      running.registry.write({
        id: this.id,
        pid: process.pid,
        port: running.endpoint.port,
        token: running.endpoint.token,
        folders: (vscode.workspace.workspaceFolders ?? []).map(folder => folder.name),
        focusedAt: this.focusedAt,
      });
    } catch (error) {
      this.log.warn('Link server: cannot register this window:', error);
    }
  }

  /** Opens a link the server received, in the window that has its folder. */
  private async route(reference: string): Promise<LaunchResult> {
    const registry = this.running?.registry;
    for (const window of WindowRegistry.choose(registry?.read() ?? [], WindowRegistry.folderOf(reference))) {
      if (window.id === this.id) {
        break;
      }
      const result = await forwardToWindow(window, reference);
      if (result) {
        this.log.info(`Link server: passed ${reference} on to the window with ${window.folders.join(', ') || 'no folder'} (${result.status})`);
        return result;
      }
      // The window has gone without removing its entry
      registry?.remove(window.id);
    }
    return this.openHere(reference);
  }

  private async openHere(reference: string): Promise<LaunchResult> {
    if (await this.open(reference)) {
      this.log.info(`Link server: opened ${reference}`);
      return { status: 204 };
    }
    return { status: 404, message: 'VS Code could not open it. VS Code shows why.' };
  }
}
