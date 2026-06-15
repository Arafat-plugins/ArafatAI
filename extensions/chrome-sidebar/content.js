function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function isVisible(el) {
  if (!el) return false;
  const style = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
}

function simpleSelector(el) {
  if (el.id) return '#' + CSS.escape(el.id);
  const attrNames = ['name', 'aria-label', 'title', 'type'];
  for (const name of attrNames) {
    const value = el.getAttribute(name);
    if (value) return `${el.tagName.toLowerCase()}[${name}="${CSS.escape(value)}"]`;
  }
  const classes = Array.from(el.classList || []).slice(0, 3).map((name) => `.${CSS.escape(name)}`).join('');
  return `${el.tagName.toLowerCase()}${classes}`;
}

function box(el) {
  const rect = el.getBoundingClientRect();
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function clickableElements() {
  return Array.from(document.querySelectorAll('a,button,input,textarea,select,label,summary,[role="button"],[onclick],[contenteditable="true"]'))
    .filter(isVisible);
}

function elementText(el) {
  return normalizeText(el.innerText || el.value || el.getAttribute('aria-label') || el.textContent);
}

function findByText(text) {
  const wanted = normalizeText(text).toLowerCase();
  if (!wanted) return null;
  return clickableElements().find((el) => elementText(el).toLowerCase().includes(wanted)) || null;
}

function findTarget(target) {
  const raw = String(target || '').trim();
  if (!raw) return null;

  if (raw.toLowerCase().startsWith('text=')) {
    return findByText(raw.slice(5));
  }

  try {
    const selectorMatch = document.querySelector(raw);
    if (selectorMatch && isVisible(selectorMatch)) return selectorMatch;
  } catch {
    return null;
  }

  return null;
}

function dispatchMouseClick(el) {
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });

  const rect = el.getBoundingClientRect();
  const x = Math.round(rect.left + rect.width / 2);
  const y = Math.round(rect.top + rect.height / 2);
  const options = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: 1,
  };

  for (const type of ['pointerover', 'mouseover', 'mousemove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    const EventClass = type.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
    el.dispatchEvent(new EventClass(type, options));
  }
}

function runAction(action) {
  if (!action || typeof action !== 'object') {
    throw new Error('Action must be an object.');
  }

  if (action.type === 'click') {
    const el = findTarget(action.target);
    if (!el) throw new Error(`Could not find click target: ${action.target || '(empty)'}`);
    dispatchMouseClick(el);
    return {
      type: 'click',
      target: action.target,
      clicked_text: elementText(el).slice(0, 160),
      selector: simpleSelector(el),
      box: box(el),
    };
  }

  if (action.type === 'type') {
    const el = findTarget(action.target);
    if (!el) throw new Error(`Could not find type target: ${action.target || '(empty)'}`);
    el.focus();
    el.value = String(action.value || '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      type: 'type',
      target: action.target,
      selector: simpleSelector(el),
      value_length: el.value.length,
    };
  }

  throw new Error(`Unsupported action type: ${action.type}`);
}

function snapshotPage() {
  const clickables = clickableElements()
    .slice(0, 120)
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      selector: simpleSelector(el),
      text: elementText(el).slice(0, 160),
      role: el.getAttribute('role') || '',
      type: el.getAttribute('type') || '',
      href: el.href || '',
      box: box(el),
    }));

  const forms = Array.from(document.querySelectorAll('form'))
    .filter(isVisible)
    .slice(0, 30)
    .map((form) => ({
      selector: simpleSelector(form),
      action: form.action || '',
      method: form.method || 'get',
      fields: Array.from(form.querySelectorAll('input,textarea,select'))
        .filter(isVisible)
        .map((field) => ({
          tag: field.tagName.toLowerCase(),
          selector: simpleSelector(field),
          name: field.getAttribute('name') || '',
          type: field.getAttribute('type') || '',
          placeholder: field.getAttribute('placeholder') || '',
          value_length: field.value ? field.value.length : 0,
        })),
    }));

  const dialogs = Array.from(document.querySelectorAll('dialog[open],[role="dialog"],.modal.show,.modal[style*="display: block"]'))
    .filter(isVisible)
    .slice(0, 20)
    .map((el) => ({
      selector: simpleSelector(el),
      text: normalizeText(el.innerText || el.textContent).slice(0, 500),
      box: box(el),
    }));

  return {
    url: location.href,
    title: document.title,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    visible_text: normalizeText(document.body ? document.body.innerText : '').slice(0, 5000),
    clickables,
    forms,
    dialogs,
    captured_at: new Date().toISOString(),
  };
}

if (!globalThis.__arafataiContentScriptLoaded) {
  globalThis.__arafataiContentScriptLoaded = true;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message) return false;

    try {
      if (message.type === 'ARAFATAI_SNAPSHOT') {
        sendResponse({ ok: true, snapshot: snapshotPage() });
        return true;
      }

      if (message.type === 'ARAFATAI_RUN_ACTION') {
        sendResponse({ ok: true, result: runAction(message.action) });
        return true;
      }
    } catch (error) {
      sendResponse({ ok: false, error: error.message || String(error) });
      return true;
    }

    return false;
  });
}
