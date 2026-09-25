interface Item {
  id: string;
  name: string;
}

/** Keep focus and row nodes stable while the composer and viewport selection update. */
export function createObjectList(container: HTMLElement, select: (id: string) => void) {
  const rows = new Map<string, HTMLButtonElement>();
  let previous: Item[] = [];
  let selected: string | null = null;
  return (items: readonly Item[], nextSelection: string | null) => {
    const changed =
      items.length !== previous.length ||
      items.some(
        (item, index) => item.id !== previous[index].id || item.name !== previous[index].name,
      );
    if (changed) {
      const retained = new Set(items.map((item) => item.id));
      for (const [id, row] of rows)
        if (!retained.has(id)) {
          row.remove();
          rows.delete(id);
        }
      const fragment = document.createDocumentFragment();
      for (const item of items) {
        let row = rows.get(item.id);
        if (!row) {
          row = document.createElement('button');
          row.className = 'object';
          row.setAttribute('aria-pressed', 'false');
          row.onclick = () => select(item.id);
          rows.set(item.id, row);
        }
        if (row.textContent !== item.name) row.textContent = item.name;
        fragment.append(row);
      }
      container.replaceChildren(fragment);
      previous = items.map(({ id, name }) => ({ id, name }));
    }
    if (selected !== nextSelection || changed) {
      if (selected) rows.get(selected)?.setAttribute('aria-pressed', 'false');
      if (nextSelection) rows.get(nextSelection)?.setAttribute('aria-pressed', 'true');
      selected = nextSelection;
    }
  };
}
