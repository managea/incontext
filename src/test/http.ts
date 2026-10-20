import * as http from 'http';

export interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * Sends a request to 127.0.0.1:`port` with exactly the given headers (Host and Origin included), unlike fetch.
 * A header set to undefined is left out.
 */
export function request(port: number, method: string, path: string, headers: http.OutgoingHttpHeaders = {}, body?: string): Promise<Response> {
  const sent = Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined));
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ host: '127.0.0.1', port, method, path, headers: sent, agent: false }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

/** The headers the link page sends with POST /launch. */
export function pageHeaders(port: number, overrides: http.OutgoingHttpHeaders = {}): http.OutgoingHttpHeaders {
  return {
    'Host': `localhost:${port}`,
    'Origin': `http://localhost:${port}`,
    'X-Incontext': '1',
    'Content-Type': 'application/json',
    ...overrides,
  };
}

/** POSTs a reference to /launch the way the link page does. */
export function launch(port: number, reference: unknown, overrides: http.OutgoingHttpHeaders = {}): Promise<Response> {
  return request(port, 'POST', '/launch', pageHeaders(port, overrides), JSON.stringify({ reference }));
}
