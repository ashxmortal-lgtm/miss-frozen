// DOM helpers. All private text is inserted with textContent/createElement —
// markup is never parsed — so a compromised API response cannot inject HTML.

export const VIEWS = Object.freeze({
  loading: 'view-loading',
  error: 'view-error',
  cover: 'view-cover',
  letter: 'view-letter',
});

export function showView(doc, name) {
  const target = VIEWS[name];
  if (!target) throw new Error(`Unknown view: ${name}`);
  for (const id of Object.values(VIEWS)) {
    const element = doc.getElementById(id);
    if (element) element.hidden = id !== target;
  }
}

export function currentView(doc) {
  for (const [name, id] of Object.entries(VIEWS)) {
    const element = doc.getElementById(id);
    if (element && !element.hidden) return name;
  }
  return null;
}

export function setText(doc, id, text) {
  const element = doc.getElementById(id);
  if (element) element.textContent = String(text ?? '');
  return element;
}

/** Render the server-delivered letter without rewriting a single character. */
export function renderLetter(doc, gift) {
  const body = doc.getElementById('letter-body');
  if (!body) throw new Error('Letter container missing');
  body.replaceChildren();

  const paragraphs = Array.isArray(gift?.paragraphs) ? gift.paragraphs : [];
  for (const paragraph of paragraphs) {
    if (typeof paragraph !== 'string') continue;
    const p = doc.createElement('p');
    p.textContent = paragraph;
    body.appendChild(p);
  }

  if (typeof gift?.title === 'string' && gift.title) {
    setText(doc, 'letter-heading', gift.title);
  }
  if (typeof gift?.occasion === 'string' && gift.occasion) {
    setText(doc, 'letter-occasion', gift.occasion);
  }
  setText(doc, 'letter-signature', gift?.signature ?? '');
}

export function showError(doc, message) {
  setText(doc, 'error-message', message);
  showView(doc, 'error');
}

export function setBusy(doc, button, busy, busyLabel = 'Opening... 🎁') {
  if (!button) return;
  if (busy) {
    if (!button.dataset.idleLabel) button.dataset.idleLabel = button.textContent;
    button.disabled = true;
    button.textContent = busyLabel;
  } else {
    button.disabled = false;
    if (button.dataset.idleLabel) button.textContent = button.dataset.idleLabel;
  }
}
