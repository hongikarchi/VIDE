/** C# verbatim string literal; not a PowerShell or JSON serializer. */
export const csharpLiteral = (value: unknown): string =>
  '@"' + String(value).replaceAll('"', '""') + '"';
