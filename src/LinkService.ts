import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { LaunchRequest, LaunchResult } from './LinkRequest';
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
 * Claude desktop app opens in its own Browser pane (see LinkServer). When the link was opened in a browser tab
 * instead, the window that opens the reference comes to the front too (bringToFront).
 *
 * Every VS Code window runs this, but only one window can own the port: the first to start. It answers every link
 * and passes each one on to the window that has the reference's workspace folder (the most recently focused one if
 * several have it, or the most recently focused window if none has). The other windows try to take the port over
 * every few seconds, so links keep working after the owner closes.
 */
export class LinkService implements vscode.Disposable {
  static readonly DEFAULT_PORT = 46266;
  /** Path of the vscode://<extension id> URI that brings a window to the front; the extension's URI handler ignores it. */
  static readonly FOCUS_PATH = '/focus';
  private static readonly RETRY_MS = 5000;
  private readonly id = crypto.randomUUID();
  private focusedAt = vscode.window.state.focused ? Date.now() : 0;
  private running?: Running;
  private disposed = false;
  private queue: Promise<void> = Promise.resolve();
  /** Set while bringToFront waits, which can take as long as VS Code's "Allow ... to open this URI?" question. */
  private focusing?: Promise<void>;
  private readonly disposables: vscode.Disposable[] = [];

  /**
   * `open` opens a reference in this window and resolves to whether it did; it shows its own errors.
   * `extensionId` is the authority of the URI that brings the window to the front (FOCUS_PATH).
   */
  constructor(private readonly page: LinkPage, private readonly extensionId: string, private readonly open: (reference: string) => Promise<boolean>, private readonly log: vscode.LogOutputChannel) {
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
    const endpoint = new WindowEndpoint(request => this.openHere(request));
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
    const server = new LinkServer(this.page, request => this.route(request));
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

  /** Opens a link the server received, in the window that has its folder, which also comes to the front if asked. */
  private async route(request: LaunchRequest): Promise<LaunchResult> {
    const registry = this.running?.registry;
    for (const window of WindowRegistry.choose(registry?.read() ?? [], WindowRegistry.folderOf(request.reference))) {
      if (window.id === this.id) {
        break;
      }
      const result = await forwardToWindow(window, request);
      if (result) {
        this.log.info(`Link server: passed ${request.reference} on to the window with ${window.folders.join(', ') || 'no folder'} (${result.status})`);
        return result;
      }
      // The window has gone without removing its entry
      registry?.remove(window.id);
    }
    return this.openHere(request);
  }

  private async openHere(request: LaunchRequest): Promise<LaunchResult> {
    if (await this.open(request.reference)) {
      this.log.info(`Link server: opened ${request.reference}`);
      // Not awaited: until you allow incontext to open vscode:// URIs, VS Code asks first, and the link page
      // mustn't wait for that answer. Clicks while it asks don't ask again.
      if (request.focus && !this.focusing) {
        this.focusing = this.bringToFront().finally(() => {
          this.focusing = undefined;
        });
      }
      return { status: 204 };
    }
    return { status: 404, message: 'VS Code could not open it. VS Code shows why.' };
  }

  /**
   * Brings this window to the front, ahead of the browser the link was clicked in. An extension can't focus its
   * window directly, but VS Code focuses the window a vscode://<extension id> URI went to once the extension's
   * URI handler has taken it, even while another app is in front. asExternalUri adds a windowId to the URI, which
   * sends it to this window rather than the most recently focused one. The URI handler ignores FOCUS_PATH.
   */
  private async bringToFront(): Promise<void> {
    try {
      const uri = await vscode.env.asExternalUri(vscode.Uri.from({ scheme: vscode.env.uriScheme, authority: this.extensionId, path: LinkService.FOCUS_PATH }));
      if (await vscode.env.openExternal(uri)) {
        this.log.info('Link server: brought this window to the front');
      } else {
        this.log.warn('Link server: VS Code did not come to the front');
      }
    } catch (error) {
      this.log.warn('Link server: cannot bring VS Code to the front:', error);
    }
  }
}
