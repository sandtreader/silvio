// Thin HTTP client over global fetch: URL construction for tenant and
// operator routes, the session cookie, and the server's {error: {code,
// message}} shape. Command logic lives in run.ts.

export class ApiError extends Error {}

export interface ClientOptions {
  server: string;
  group?: string;
  cookie?: string;
}

export interface ApiResponse {
  body: unknown;
  cookie?: string; // silvio_session value when the response set one
}

export class Client {
  private readonly server: string;
  private readonly group: string | undefined;
  private readonly cookie: string | undefined;

  constructor(options: ClientOptions) {
    this.server = options.server.replace(/\/+$/, '');
    this.group = options.group;
    this.cookie = options.cookie;
  }

  /** Member/tenant route via the /g/{slug} host-independent prefix. */
  groupUrl(path: string): string {
    if (this.group === undefined) {
      throw new ApiError('no group configured — run: silvio login');
    }
    return `${this.server}/api/v1/g/${this.group}${path}`;
  }

  operatorUrl(path: string): string {
    return `${this.server}/api/v1/operator${path}`;
  }

  async request(method: string, url: string, body?: unknown): Promise<ApiResponse> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookie !== undefined) headers['cookie'] = `silvio_session=${this.cookie}`;
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new ApiError(`cannot reach ${url}: ${detail}`);
    }
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text === '' ? undefined : JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      const message = (parsed as { error?: { message?: unknown } } | undefined)?.error?.message;
      throw new ApiError(
        typeof message === 'string' ? message : `${response.status} ${response.statusText}`,
      );
    }
    const result: ApiResponse = { body: parsed };
    const setCookie = response.headers.get('set-cookie');
    if (setCookie !== null) {
      const match = /(?:^|[\s,])silvio_session=([^;,\s]*)/.exec(setCookie);
      if (match?.[1] !== undefined) result.cookie = match[1];
    }
    return result;
  }
}
