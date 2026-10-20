import * as fs from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as path from 'path';
import { Launch, LaunchResult, LinkRequest } from './LinkRequest';

export interface LinkPage {
  html: string;
  script: string;
}

/**
 * The link server: answers http://localhost:<port>/open#@project/path:L34:43 links on 127.0.0.1.
 *
 * GET /open serves a page whose script (media/link-page.js) posts the reference in the fragment to POST /launch,
 * so the reference never reaches the server in a URL. Only that page can call /launch (see LinkRequest.checkLaunch).
 * The Claude desktop app opens localhost links in its own Browser pane, which can't open vscode:// links, so the
 * page asks this server instead, and VS Code opens the reference without coming to the front.
 */
export class LinkServer {
  static readonly PAGE_PATH = '/open';
  static readonly SCRIPT_PATH = '/open.js';
  static readonly LAUNCH_PATH = '/launch';
  static readonly CONTENT_SECURITY_POLICY = "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  private readonly server: http.Server;

  /** `launch` opens a reference that passed the checks. */
  constructor(private readonly page: LinkPage, private readonly launch: Launch) {
    this.server = http.createServer((request, response) => {
      this.handle(request, response).catch(error => LinkServer.send(response, { status: 500, message: String(error) }));
    });
    this.server.requestTimeout = 10_000;
    this.server.headersTimeout = 10_000;
    // Errors after listening (rare, such as running out of file handles) must not take the extension host down
    this.server.on('error', () => undefined);
  }

  /** Loads the page from the extension's media folder; `uriPrefix` (vscode://managea.incontext) is for its fallback link. */
  static loadPage(mediaFolder: string, uriPrefix: string): LinkPage {
    const html = fs.readFileSync(path.join(mediaFolder, 'link-page.html'), 'utf8');
    const attribute = uriPrefix.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return {
      html: html.replace('{{URI_PREFIX}}', attribute),
      script: fs.readFileSync(path.join(mediaFolder, 'link-page.js'), 'utf8'),
    };
  }

  /** Listens on 127.0.0.1:`port` (0 picks a free port). Resolves to false when the port can't be used, usually because it is taken. */
  listen(port: number): Promise<boolean> {
    return new Promise(resolve => {
      const onError = () => resolve(false);
      this.server.once('error', onError);
      this.server.listen(port, '127.0.0.1', () => {
        this.server.off('error', onError);
        resolve(true);
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
    // Another site's page could reach this server under its own host name (DNS rebinding), and every
    // cross-site request that isn't a simple GET or POST starts with a preflight
    if (request.method === 'OPTIONS' || !LinkRequest.isAllowedHost(this.port, request.headers.host)) {
      return LinkServer.send(response, { status: 403, message: 'Forbidden' });
    }
    const url = (request.url ?? '').split('?')[0];
    if (request.method === 'GET' && url === LinkServer.PAGE_PATH) {
      return LinkServer.sendFile(response, 'text/html; charset=utf-8', this.page.html, {
        'Content-Security-Policy': LinkServer.CONTENT_SECURITY_POLICY,
        'Referrer-Policy': 'no-referrer',
        'X-Frame-Options': 'DENY',
      });
    }
    if (request.method === 'GET' && url === LinkServer.SCRIPT_PATH) {
      return LinkServer.sendFile(response, 'text/javascript; charset=utf-8', this.page.script, {});
    }
    if (request.method === 'POST' && url === LinkServer.LAUNCH_PATH) {
      const body = await LinkRequest.readBody(request);
      if (body === undefined) {
        response.setHeader('Connection', 'close');
        return LinkServer.send(response, { status: 413, message: 'Request too large' });
      }
      const checked = LinkRequest.checkLaunch(this.port, request.headers, body);
      return LinkServer.send(response, 'reference' in checked ? await this.launch(checked.reference) : checked);
    }
    return LinkServer.send(response, { status: 404, message: 'Not found' });
  }

  private static sendFile(response: http.ServerResponse, contentType: string, body: string, headers: http.OutgoingHttpHeaders): void {
    response.writeHead(200, {
      ...headers,
      'Content-Type': contentType,
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(body);
  }

  /** Sends a result, with its message as plain text for the page to show. */
  static send(response: http.ServerResponse, result: LaunchResult): void {
    if (response.headersSent) {
      response.end();
      return;
    }
    const body = result.status === 204 ? '' : result.message ?? '';
    response.writeHead(result.status, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(body);
  }
}
