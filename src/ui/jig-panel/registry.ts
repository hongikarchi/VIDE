// Basis chips → fact window (SPEC-07.6 근거, Design 근거 칩, PLAN-22 T-065). A setting whose value
// rests on a project statement names it as `basis.statementId`, as an `S<n>` (SPEC-08.6, the form
// the engine's `factRefIds` reads) or `statement:<n>` entry of `basis.factRefs`, or as its `ref`
// when it was set from a fact. A chip that carries
// `data-fact-statement` opens the fact window on click, wherever it is drawn (panel, slider board,
// report); `listenForBasisChips` installs that one delegated listener. Pure apart from the listener,
// so tests can check the id rules in Node.

import type { PanelSetting } from './bindings.ts';

/** The attribute a basis chip carries to open the fact window. */
export const FACT_ATTRIBUTE = 'data-fact-statement';

const STATEMENT_REF = /^(?:statement|stmt|fact|진술|s)?[:#\s]*(\d{1,12})$/i;
function idOf(value: unknown): number | undefined {
  if (typeof value === 'number')
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const match = STATEMENT_REF.exec(value.trim());
  return match ? Number(match[1]) : undefined;
}

/** The statement a setting's value rests on, when it names one. */
export function statementOf(
  setting: Pick<PanelSetting, 'by' | 'ref'> & {
    basis?: PanelSetting['basis'] & { statementId?: unknown; factRefs?: unknown };
  },
): number | undefined {
  // A value set from a fact rests on that statement, not on the declared basis of the default.
  const fromFact = setting.by === 'fact' ? idOf(setting.ref) : undefined;
  if (fromFact !== undefined) return fromFact;
  const basis = setting.basis;
  const direct = idOf(basis?.statementId);
  if (direct !== undefined) return direct;
  if (Array.isArray(basis?.factRefs))
    for (const ref of basis.factRefs) {
      const id = idOf(ref);
      if (id !== undefined) return id;
    }
  return undefined;
}

/** Attributes for a chip element: spread them on the chip so a click opens the fact window. */
export function basisAttributes(setting: Parameters<typeof statementOf>[0]) {
  const id = statementOf(setting);
  return id === undefined
    ? {}
    : {
        [FACT_ATTRIBUTE]: String(id),
        role: 'button',
        tabIndex: 0,
        'aria-haspopup': 'dialog' as const,
      };
}

type Opener = (statementId: number) => void;
let installed: ((event: Event) => void) | undefined;
/**
 * One delegated listener for the page: a click (or Enter/Space) on an element carrying
 * `data-fact-statement` calls `open` with its statement id. Calling again replaces the opener.
 */
export function listenForBasisChips(open: Opener) {
  if (installed) {
    document.removeEventListener('click', installed);
    document.removeEventListener('keydown', installed);
  }
  installed = (event: Event) => {
    if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target instanceof Element ? event.target : null;
    const chip = target?.closest(`[${FACT_ATTRIBUTE}]`);
    const id = idOf(chip?.getAttribute(FACT_ATTRIBUTE));
    if (id === undefined) return;
    event.preventDefault();
    open(id);
  };
  document.addEventListener('click', installed);
  document.addEventListener('keydown', installed);
}
