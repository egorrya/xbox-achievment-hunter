const timers = new WeakMap();
export function dismissNotification(element) {
  clearTimeout(timers.get(element));
  timers.delete(element);
  element.hidden = true;
}
export function showNotification(element, message, {dismissible = true, timeout = 10000} = {}) {
  clearTimeout(timers.get(element));
  timers.delete(element);
  element.replaceChildren();
  element.hidden = !message;
  if (!message) return;
  const text = document.createElement('span');
  text.className = 'notification-text';
  text.textContent = message;
  element.append(text);
  if (!dismissible) return;
  const close = document.createElement('button');
  close.type = 'button'; close.className = 'notification-close';
  close.setAttribute('aria-label', 'Dismiss message'); close.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-x"></use></svg>'; 
  close.onclick = () => dismissNotification(element);
  element.append(close);
  timers.set(element, setTimeout(() => dismissNotification(element), timeout));
}
