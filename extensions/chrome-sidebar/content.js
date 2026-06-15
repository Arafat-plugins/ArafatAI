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

function snapshotPage() {
  const clickables = Array.from(document.querySelectorAll('a,button,input,textarea,select,label,summary,[role="button"],[onclick],[contenteditable="true"]'))
    .filter(isVisible)
    .slice(0, 120)
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      selector: simpleSelector(el),
      text: normalizeText(el.innerText || el.value || el.getAttribute('aria-label') || el.textContent).slice(0, 160),
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'ARAFATAI_SNAPSHOT') return false;
  sendResponse({ ok: true, snapshot: snapshotPage() });
  return true;
});

