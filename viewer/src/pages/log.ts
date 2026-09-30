// LOG — everything the studio was told, newest first (kept to the last 300 lines).
import { $ } from '../ui';

export function log(s: string, time = new Date()): void {
  const box = $('log');
  const el = document.createElement('div');
  el.textContent = `${time.toLocaleTimeString()}  ${s}`;
  box.prepend(el);
  $('logEmpty').hidden = true;
  while (box.childElementCount > 300) box.lastChild!.remove();
}
