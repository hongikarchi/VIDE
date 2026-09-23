export class DomainError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
