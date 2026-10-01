// 피드백 보내기 (user request 2026-10-01): the rail's feedback button opens a small dialog that
// sends the person to a Google Form in the default browser (the desktop shell opens new windows
// there, src/desktop/shell/ShellForm.cs NewWindowRequested). The form address is one constant;
// while it is empty the dialog says so and the open button stays disabled.
import { append as el } from './elements.ts';

/** The Google Form for feedback. Empty until the user gives the address. */
export const FEEDBACK_FORM_URL = '';

export function showFeedback(url: string = FEEDBACK_FORM_URL) {
  const dialog = document.createElement('dialog');
  dialog.className = 'feedback-dialog';
  dialog.setAttribute('aria-labelledby', 'feedback-title');
  // The box fills the dialog, so a click on the dialog itself is a click on the backdrop.
  const box = el('div', '', dialog, { class: 'feedback-box' });
  el('h2', '피드백 보내기', box, { id: 'feedback-title' });
  el(
    'p',
    url
      ? '구글폼에서 의견을 남겨 주시면 감사하겠습니다.'
      : '피드백 양식 주소가 아직 설정되지 않았습니다.',
    box,
  );
  const row = el('div', '', box, { class: 'feedback-actions' });
  const open = el('button', '구글폼 열기', row, { type: 'button', class: 'primary-button' });
  open.disabled = !url;
  open.onclick = () => {
    if (!url) return;
    window.open(url, '_blank', 'noopener');
    dialog.close();
  };
  el('button', '닫기', row, { type: 'button' }).onclick = () => dialog.close();
  // A click on the backdrop closes it; Esc too (the dialog's own cancel).
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}
