const CHATGPT_PROMPT_PARAM = "ordinator_prompt";

function getPromptFromUrl() {
  const url = new URL(window.location.href);
  const prompt = url.searchParams.get(CHATGPT_PROMPT_PARAM);
  return typeof prompt === "string" ? prompt.trim() : "";
}

function clearPromptFromUrl() {
  const url = new URL(window.location.href);
  url.searchParams.delete(CHATGPT_PROMPT_PARAM);
  window.history.replaceState({}, "", url.toString());
}

function setTextareaValue(textarea, value) {
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value");
  if (descriptor?.set) {
    descriptor.set.call(textarea, value);
  } else {
    textarea.value = value;
  }
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.dispatchEvent(new Event("change", { bubbles: true }));
}

function findComposer() {
  return document.querySelector("#prompt-textarea, textarea");
}

function findSendButton() {
  return document.querySelector(
    'button[data-testid="send-button"], button[aria-label*="Send"], button[aria-label*="send"]'
  );
}

async function waitForComposer(timeoutMs = 20000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const composer = findComposer();
    if (composer) {
      return composer;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
  return null;
}

async function submitPrompt(prompt) {
  const composer = await waitForComposer();
  if (!composer) {
    return;
  }

  setTextareaValue(composer, prompt);
  composer.focus();

  let attempts = 0;
  while (attempts < 20) {
    const sendButton = findSendButton();
    if (sendButton && !sendButton.disabled) {
      sendButton.click();
      clearPromptFromUrl();
      return;
    }
    attempts += 1;
    await new Promise((resolve) => window.setTimeout(resolve, 200));
  }
}

const prompt = getPromptFromUrl();
if (prompt) {
  void submitPrompt(prompt);
}
