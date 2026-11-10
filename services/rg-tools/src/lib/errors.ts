export class NotConfigured extends Error {
  constructor(what: string) {
    super(`${what} is not configured`);
    this.name = 'NotConfigured';
  }
}

export type FetchErrorCode =
  | 'invalid_url'
  | 'unsupported_protocol'
  | 'blocked_port'
  | 'blocked_address'
  | 'dns_failed'
  | 'robots_disallowed'
  | 'too_many_redirects'
  | 'http_error'
  | 'unsupported_content_type'
  | 'timeout';

export class FetchError extends Error {
  constructor(
    public readonly code: FetchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FetchError';
  }
}
