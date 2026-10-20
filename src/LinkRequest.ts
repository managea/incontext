import { IncomingHttpHeaders, IncomingMessage } from 'http';

/** What opening a reference sent to the link server came to: 204 when it opened, or an error status and why. */
export interface LaunchResult {
  status: number;
  message?: string;
}

export type Launch = (reference: string) => Promise<LaunchResult>;

/**
 * The checks on requests to the link server (LinkServer) and the window endpoints (LinkWindows),
 * kept free of the vscode API so they can be tested on their own.
 */
export class LinkRequest {
  static readonly MAX_BODY_BYTES = 4096;
  // One reference, as written after the `#` of a link-server link: http://localhost:<port>/open#@project/path:L34:43
  private static readonly REFERENCE_PATTERN = /^@[^\s@]+$/;
  // A `..` path segment, which could step out of the reference's workspace folder
  private static readonly PARENT_SEGMENT = /(^|[\/\\])\.\.([\/\\:#]|$)/;

  /**
   * Whether `reference` is a single `@` reference without a `..` segment. References are percent-decoded once more
   * when they are resolved (ReferenceUtils.resolveReference), so `%2e%2e` counts as `..` too.
   */
  static isReference(reference: unknown): reference is string {
    if (typeof reference !== 'string' || !LinkRequest.REFERENCE_PATTERN.test(reference)) {
      return false;
    }
    const path = reference.substring(1);
    return ![path, LinkRequest.safeDecode(path)].some(form => LinkRequest.PARENT_SEGMENT.test(form));
  }

  /** The Host header values a request to the server on `port` may carry; any other host means DNS rebinding. */
  static isAllowedHost(port: number, host: string | undefined): boolean {
    return host !== undefined && LinkRequest.hosts(port).includes(host.toLowerCase());
  }

  /**
   * Checks a POST /launch request: it must come from the link page this server serves, which only that page can do.
   * Another site's page can't send the X-Incontext header without a CORS preflight, and the server refuses every one.
   */
  static checkLaunch(port: number, headers: IncomingHttpHeaders, body: string): { reference: string } | LaunchResult {
    if (!LinkRequest.isAllowedHost(port, headers.host)) {
      return { status: 403, message: 'Unexpected Host header' };
    }
    if (!LinkRequest.hosts(port).some(host => headers.origin === `http://${host}`)) {
      return { status: 403, message: 'Unexpected Origin header' };
    }
    if (headers['x-incontext'] !== '1') {
      return { status: 403, message: 'Missing X-Incontext header' };
    }
    return LinkRequest.checkBody(body);
  }

  /** Checks a request body: JSON of at most MAX_BODY_BYTES with a `reference` that passes isReference. */
  static checkBody(body: string): { reference: string } | LaunchResult {
    if (Buffer.byteLength(body, 'utf8') > LinkRequest.MAX_BODY_BYTES) {
      return { status: 413, message: 'Request too large' };
    }
    let reference: unknown;
    try {
      reference = JSON.parse(body)?.reference;
    } catch {
      return { status: 400, message: 'Expected JSON' };
    }
    if (!LinkRequest.isReference(reference)) {
      return { status: 400, message: 'Not an incontext reference' };
    }
    return { reference };
  }

  /** Reads a request body as text, or resolves to undefined once it grows past `limit` bytes. */
  static readBody(request: IncomingMessage, limit = LinkRequest.MAX_BODY_BYTES): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
      if (Number(request.headers['content-length']) > limit) {
        resolve(undefined);
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      request.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) {
          request.pause();
          resolve(undefined);
        } else {
          chunks.push(chunk);
        }
      });
      request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      request.on('error', reject);
    });
  }

  private static hosts(port: number): string[] {
    return [`localhost:${port}`, `127.0.0.1:${port}`];
  }

  private static safeDecode(value: string): string {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
}
