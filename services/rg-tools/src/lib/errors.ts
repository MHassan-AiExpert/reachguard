export class NotConfigured extends Error {
  constructor(what: string) {
    super(`${what} is not configured`);
    this.name = 'NotConfigured';
  }
}
