interface Controls {
  body: HTMLTextAreaElement;
  'host-target': HTMLSelectElement;
  model: HTMLSelectElement;
  effort: HTMLInputElement;
  permission: HTMLSelectElement;
  plane: HTMLSelectElement;
  'line-role': HTMLSelectElement;
  projection: HTMLSelectElement;
  files: HTMLInputElement;
  'model-file': HTMLInputElement;
  'point-u': HTMLInputElement;
  'point-v': HTMLInputElement;
  'attach-menu': HTMLDetailsElement;
  'draft-menu': HTMLDetailsElement;
  request: HTMLButtonElement;
  pin: HTMLButtonElement;
  'add-request': HTMLButtonElement;
  'linked-targets': HTMLButtonElement;
  'finish-sketch': HTMLButtonElement;
  'undo-point': HTMLButtonElement;
  'import-model': HTMLButtonElement;
}
export function element<K extends keyof Controls>(id: K): Controls[K];
export function element(id: string): HTMLElement;
export function element(id: string) {
  const node = document.getElementById(id);
  if (!node) throw Error('Missing workspace element: ' + id);
  return node;
}
export function append<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text: string,
  parent: HTMLElement,
  attributes: Record<string, string> = {},
) {
  const node = document.createElement(tag);
  node.textContent = text;
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  parent.append(node);
  return node;
}
export function readableError(value: unknown): Error & { code?: string } {
  if (value instanceof Error) return value;
  return new Error(typeof value === 'string' ? value : '요청을 처리하지 못했습니다.');
}
