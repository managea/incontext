import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { Launch, LaunchResult, LinkRequest } from './LinkRequest';
import { LinkServer } from './LinkServer';

/** A VS Code window that can open references passed on by the window that owns the link server's port. */
export interface WindowEntry {
  id: string;
  /** The window's extension host process, to tell windows that have gone without removing their entry. */
  pid: number;
  /** Port of the window's WindowEndpoint on 127.0.0.1. */
  port: number;
  token: string;
  /** Names of the window's workspace folders. */
  folders: string[];
  /** When the window last had focus (ms since the epoch), 0 if not since it started. */
  focusedAt: number;
}

/**
 * Every VS Code window runs its own extension host, but only one can own the link server's port. So each window
 * registers here, in a folder only this user can read, and the owner passes each link on to the window that has
 * the reference's folder.
 */
export class WindowRegistry {
  private constructor(readonly directory: string) {}

  /**
   * The registry of the windows sharing link server port `port`, or undefined when its folder can't be made
   * private to this user. Without it the owner of the port opens every link itself.
   */
  static open(port: number, base = os.tmpdir()): WindowRegistry | undefined {
    const userFolder = path.join(base, `incontext-${process.getuid?.() ?? os.userInfo().username}`);
    try {
      fs.mkdirSync(userFolder, { recursive: true, mode: 0o700 });
      // The registry holds the tokens that let a process open references in a window, so another user
      // must not be able to read it or to have made the folder first
      const stat = fs.lstatSync(userFolder);
      const ours = process.getuid === undefined || stat.uid === process.getuid();
      if (!stat.isDirectory() || !ours || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
        return undefined;
      }
      const directory = path.join(userFolder, `links-${port}`);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      return new WindowRegistry(directory);
    } catch {
      return undefined;
    }
  }

  write(entry: WindowEntry): void {
    const file = this.fileOf(entry.id);
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(entry), { mode: 0o600 });
    fs.renameSync(temporary, file);
  }

  remove(id: string): void {
    fs.rmSync(this.fileOf(id), { force: true });
  }

  /** The registered windows, dropping those whose extension host has exited. */
  read(): WindowEntry[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.directory).filter(name => name.endsWith('.json'));
    } catch {
      return [];
    }
    const entries: WindowEntry[] = [];
    for (const name of names) {
      let entry: unknown;
      try {
        entry = JSON.parse(fs.readFileSync(path.join(this.directory, name), 'utf8'));
      } catch {
        continue;
      }
      if (!WindowRegistry.isEntry(entry) || this.fileOf(entry.id) !== path.join(this.directory, name)) {
        continue;
      }
      if (WindowRegistry.isRunning(entry.pid)) {
        entries.push(entry);
      } else {
        this.remove(entry.id);
      }
    }
    return entries;
  }

  /**
   * The windows to try for a reference into workspace folder `folder`, best first: those that have the folder,
   * most recently focused first, or every window that way when none has it.
   */
  static choose(entries: readonly WindowEntry[], folder: string | undefined): WindowEntry[] {
    const byFocus = [...entries].sort((a, b) => b.focusedAt - a.focusedAt);
    const withFolder = folder === undefined ? [] : byFocus.filter(entry => entry.folders.includes(folder));
    return withFolder.length > 0 ? withFolder : byFocus;
  }

  /** The workspace folder name a reference starts with (`project` in `@project/src/file.ts:L3`), if it has a path after it. */
  static folderOf(reference: string): string | undefined {
    let body = reference.startsWith('@') ? reference.substring(1) : reference;
    try {
      body = decodeURIComponent(body);
    } catch {
      // ReferenceUtils.resolveReference uses the path as it is, too
    }
    const slash = body.indexOf('/');
    return slash > 0 ? body.substring(0, slash) : undefined;
  }

  private fileOf(id: string): string {
    return path.join(this.directory, `${id.replace(/[^A-Za-z0-9-]/g, '')}.json`);
  }

  private static isEntry(value: unknown): value is WindowEntry {
    const entry = value as Partial<WindowEntry> | null;
    return typeof entry?.id === 'string' && typeof entry.pid === 'number' && typeof entry.port === 'number'
      && typeof entry.token === 'string' && typeof entry.focusedAt === 'number'
      && Array.isArray(entry.folders) && entry.folders.every(folder => typeof folder === 'string');
  }

  private static isRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM: the process exists but belongs to someone else
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }
}

/**
 * A window's private endpoint on 127.0.0.1, which opens references the owner of the link server passes on.
 * Requests must carry the window's token from the registry, which only this user can read.
 */
export class WindowEndpoint {
  static readonly OPEN_PATH = '/open';
  readonly token = crypto.randomBytes(32).toString('base64url');
  private readonly server: http.Server;

  constructor(private readonly open: Launch) {
    this.server = http.createServer((request, response) => {
      this.handle(request, response).catch(error => LinkServer.send(response, { status: 500, message: String(error) }));
    });
    this.server.requestTimeout = 10_000;
    this.server.headersTimeout = 10_000;
    this.server.on('error', () => undefined);
  }

  /** Listens on a free port on 127.0.0.1 and resolves to it. */
  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject);
        resolve(this.port);
      });
    });
  }

  get port(): number {
    return (this.server.address() as AddressInfo | null)?.port ?? 0;
  }

  close(): Promise<void> {
    return new Promise(resolve => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    // Browsers send an Origin header with every POST, so a page can't call this even with the token
    const allowed = request.method === 'POST' && request.url === WindowEndpoint.OPEN_PATH
      && request.headers.host === `127.0.0.1:${this.port}` && request.headers.origin === undefined
      && WindowEndpoint.tokenMatches(request.headers.authorization, this.token);
    if (!allowed) {
      return LinkServer.send(response, { status: 403, message: 'Forbidden' });
    }
    const body = await LinkRequest.readBody(request);
    if (body === undefined) {
      response.setHeader('Connection', 'close');
      return LinkServer.send(response, { status: 413, message: 'Request too large' });
    }
    const checked = LinkRequest.checkBody(body);
    return LinkServer.send(response, 'reference' in checked ? await this.open(checked.reference) : checked);
  }

  private static tokenMatches(authorization: string | undefined, token: string): boolean {
    const given = Buffer.from(authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  }
}

/**
 * Passes a reference on to another window's endpoint. Resolves to undefined when the window can't be reached,
 * which means it has gone.
 */
export function forwardToWindow(entry: WindowEntry, reference: string, timeoutMs = 10_000): Promise<LaunchResult | undefined> {
  return new Promise(resolve => {
    const body = JSON.stringify({ reference });
    const request = http.request({
      host: '127.0.0.1',
      port: entry.port,
      method: 'POST',
      path: WindowEndpoint.OPEN_PATH,
      agent: false,
      timeout: timeoutMs,
      headers: {
        'Authorization': `Bearer ${entry.token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 502, message: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', () => resolve({ status: 502, message: 'The VS Code window that has this folder stopped answering' }));
    });
    request.on('timeout', () => {
      request.destroy();
      resolve({ status: 504, message: 'The VS Code window that has this folder did not answer in time' });
    });
    request.on('error', () => resolve(undefined));
    request.end(body);
  });
}
