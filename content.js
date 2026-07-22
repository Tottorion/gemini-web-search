(function () {
  "use strict";

  if (location.hostname !== "gemini.google.com") return;

  const CONTROL_ID = "gemini-web-search-control";
  const SUPPORTED_PATH_PATTERN =
    /^\/(?:u\/\d+\/)?(?:app|images|gem)(?:\/|$)/;
  const SUFFIX = "最新情報";
  const IME_PROCESSING_KEY_CODE = 229;
  const EDITOR_SCORE = Object.freeze({
    RICH_TEXTAREA: 100,
    TEXTBOX_ROLE: 30,
    MULTILINE: 20,
    PROMPT_HINT: 50,
    IN_VIEWPORT: 10,
    VIEWPORT_MARGIN_PX: 100,
    POSITION_MAX: 20,
  });
  const MODEL_SCORE = Object.freeze({
    ATTRIBUTE_HINT: 100,
    NAME_HINT: 70,
    DROPDOWN_HINT: 10,
    POSITION_MAX: 30,
    POSITION_FALLOFF_PX: 6,
    RIGHT_OF_EDITOR: 10,
    MINIMUM: 60,
    EARLY_EXIT: 100,
  });
  const MODEL_SEARCH = Object.freeze({
    MAX_ANCESTOR_DEPTH: 9,
    MAX_VERTICAL_DISTANCE_PX: 160,
    EDITOR_HEIGHT_BUFFER_PX: 80,
  });
  const ACTION_ROW_SEARCH = Object.freeze({
    MAX_ANCESTOR_DEPTH: 6,
    MIN_VISIBLE_BUTTONS: 2,
  });
  const EDITOR_SELECTORS = [
    'rich-textarea [contenteditable="true"][role="textbox"]',
    '[contenteditable="true"][role="textbox"][aria-multiline="true"]',
    'textarea[aria-label*="prompt" i]',
    'textarea[placeholder*="prompt" i]',
    'textarea[aria-label*="質問"]',
    'textarea[placeholder*="質問"]',
  ];
  const EDITOR_SELECTOR = EDITOR_SELECTORS.join(",");

  let checkbox = null;
  let control = null;
  let currentEditor = null;
  let mountScheduled = false;

  function isSupportedPage() {
    return SUPPORTED_PATH_PATTERN.test(location.pathname);
  }

  function unmountControl() {
    if (control?.isConnected) control.remove();
    currentEditor = null;
  }

  function isVisible(element) {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      element.getClientRects().length > 0
    );
  }

  function editorScore(editor) {
    let score = 0;
    if (editor.closest("rich-textarea")) score += EDITOR_SCORE.RICH_TEXTAREA;
    if (editor.getAttribute("role") === "textbox") score += EDITOR_SCORE.TEXTBOX_ROLE;
    if (editor.getAttribute("aria-multiline") === "true") score += EDITOR_SCORE.MULTILINE;

    const hint = [
      editor.getAttribute("aria-label"),
      editor.getAttribute("placeholder"),
      editor.getAttribute("data-placeholder"),
    ]
      .filter(Boolean)
      .join(" ");

    if (/prompt|message|質問|メッセージ/i.test(hint)) score += EDITOR_SCORE.PROMPT_HINT;

    const rect = editor.getBoundingClientRect();
    if (
      rect.top >= 0 &&
      rect.bottom <= window.innerHeight + EDITOR_SCORE.VIEWPORT_MARGIN_PX
    ) {
      score += EDITOR_SCORE.IN_VIEWPORT;
    }
    score += Math.max(
      0,
      Math.min(
        EDITOR_SCORE.POSITION_MAX,
        (rect.top / Math.max(window.innerHeight, 1)) * EDITOR_SCORE.POSITION_MAX
      )
    );
    return score;
  }

  function findPromptEditor(root = document) {
    const candidates = Array.from(root.querySelectorAll(EDITOR_SELECTOR)).filter(
      (editor) => editor.id !== CONTROL_ID && isVisible(editor)
    );

    candidates.sort((left, right) => editorScore(right) - editorScore(left));
    return candidates[0] || null;
  }

  function createControl() {
    const host = document.createElement("div");
    host.id = CONTROL_ID;

    const label = document.createElement("label");
    label.className = "gemini-web-search-label";

    const input = document.createElement("input");
    input.className = "gemini-web-search-checkbox";
    input.type = "checkbox";
    input.setAttribute("aria-label", "Webを検索");

    const text = document.createElement("span");
    text.className = "gemini-web-search-text";
    text.textContent = "Webを検索";

    label.append(input, text);
    host.append(label);

    checkbox = input;
    return host;
  }

  function normalizedText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function elementSignature(element) {
    return [
      element.tagName,
      element.getAttribute("aria-label"),
      element.getAttribute("data-tooltip"),
      element.getAttribute("data-test-id"),
      element.getAttribute("title"),
      typeof element.className === "string" ? element.className : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  function modelButtonScore(button, editor) {
    if (!(button instanceof HTMLElement) || !isVisible(button)) return -1;

    const signature = elementSignature(button);
    const text = normalizedText(button.textContent);
    let score = 0;

    if (/model|mode-switcher|モデル|モード選択/i.test(signature)) {
      score += MODEL_SCORE.ATTRIBUTE_HINT;
    }
    if (
      /^(?:gemini\s*)?(?:(?:\d+(?:\.\d+)?)\s*)?(?:pro|flash(?:-lite)?|fast|thinking|deep think)/i.test(
        text
      )
    ) {
      score += MODEL_SCORE.NAME_HINT;
    }
    if (/expand_more|arrow_drop_down|keyboard_arrow_down/i.test(`${signature} ${text}`)) {
      score += MODEL_SCORE.DROPDOWN_HINT;
    }

    if (score === 0) return -1;

    const editorRect = editor.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const editorCenterY = editorRect.top + editorRect.height / 2;
    const buttonCenterY = buttonRect.top + buttonRect.height / 2;
    const verticalDistance = Math.abs(editorCenterY - buttonCenterY);

    if (
      verticalDistance >
      Math.max(
        MODEL_SEARCH.MAX_VERTICAL_DISTANCE_PX,
        editorRect.height + MODEL_SEARCH.EDITOR_HEIGHT_BUFFER_PX
      )
    ) {
      return -1;
    }
    score += Math.max(
      0,
      MODEL_SCORE.POSITION_MAX - verticalDistance / MODEL_SCORE.POSITION_FALLOFF_PX
    );
    if (buttonRect.left >= editorRect.left) score += MODEL_SCORE.RIGHT_OF_EDITOR;

    return score;
  }

  function findModelButton(editor) {
    let container = editor.parentElement;
    let bestButton = null;
    let bestScore = -1;
    let depth = 0;

    while (
      container &&
      container !== document.body &&
      depth < MODEL_SEARCH.MAX_ANCESTOR_DEPTH
    ) {
      const buttons = container.querySelectorAll('button, [role="button"]');

      for (const button of buttons) {
        const score = modelButtonScore(button, editor);
        if (score > bestScore) {
          bestButton = button;
          bestScore = score;
        }
      }

      if (bestScore >= MODEL_SCORE.EARLY_EXIT) break;
      container = container.parentElement;
      depth += 1;
    }

    return bestScore >= MODEL_SCORE.MINIMUM ? bestButton : null;
  }

  function findActionRow(modelButton) {
    let child = modelButton;
    let parent = modelButton.parentElement;
    let depth = 0;

    while (
      parent &&
      parent !== document.body &&
      depth < ACTION_ROW_SEARCH.MAX_ANCESTOR_DEPTH
    ) {
      const display = getComputedStyle(parent).display;
      const visibleButtonCount = Array.from(
        parent.querySelectorAll('button, [role="button"]')
      ).filter(isVisible).length;

      if (
        (display === "flex" || display === "inline-flex") &&
        visibleButtonCount >= ACTION_ROW_SEARCH.MIN_VISIBLE_BUTTONS
      ) {
        return { container: parent, anchor: child };
      }

      child = parent;
      parent = parent.parentElement;
      depth += 1;
    }

    return null;
  }

  function mountControl() {
    mountScheduled = false;

    if (!isSupportedPage()) {
      unmountControl();
      return;
    }

    const editor = findPromptEditor();
    if (!editor) {
      unmountControl();
      return;
    }

    currentEditor = editor;

    const modelButton = findModelButton(editor);
    if (!modelButton) {
      unmountControl();
      return;
    }

    const actionRow = findActionRow(modelButton);
    if (!actionRow) {
      unmountControl();
      return;
    }

    if (!control) control = createControl();

    if (
      control.parentElement !== actionRow.container ||
      control.nextSibling !== actionRow.anchor
    ) {
      actionRow.container.insertBefore(control, actionRow.anchor);
    }
    control.style.visibility = "visible";
  }

  function scheduleMount() {
    if (mountScheduled) return;
    mountScheduled = true;
    requestAnimationFrame(mountControl);
  }

  function editorText(editor) {
    if (editor instanceof HTMLTextAreaElement) return editor.value;
    return editor.innerText || editor.textContent || "";
  }

  function endsWithSuffix(value) {
    return new RegExp(`${SUFFIX}\\s*$`, "u").test(value);
  }

  function dispatchInput(editor, appendedText) {
    let event;

    try {
      event = new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "insertText",
        data: appendedText,
      });
    } catch (_error) {
      event = new Event("input", { bubbles: true, composed: true });
    }

    editor.dispatchEvent(event);
  }

  function appendToTextarea(editor, appendedText) {
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set;
    const nextValue = `${editor.value}${appendedText}`;

    if (valueSetter) valueSetter.call(editor, nextValue);
    else editor.value = nextValue;

    editor.selectionStart = nextValue.length;
    editor.selectionEnd = nextValue.length;
    dispatchInput(editor, appendedText);
  }

  function appendToContentEditable(editor, appendedText) {
    editor.focus({ preventScroll: true });

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);

    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }

    const inserted = document.execCommand("insertText", false, appendedText);

    if (!inserted) {
      range.insertNode(document.createTextNode(appendedText));
      range.collapse(false);
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
      dispatchInput(editor, appendedText);
    }
  }

  function appendLatestInfo(editor) {
    if (
      !isSupportedPage() ||
      !checkbox?.checked ||
      !editor ||
      !isVisible(editor)
    ) {
      return;
    }

    const value = editorText(editor);
    if (!value.trim() || endsWithSuffix(value)) return;

    const appendedText = "\n\n" + SUFFIX;

    if (editor instanceof HTMLTextAreaElement) {
      appendToTextarea(editor, appendedText);
      return;
    }

    appendToContentEditable(editor, appendedText);
  }

  function editorFromEventTarget(target) {
    if (!(target instanceof Element)) return null;
    return target.closest(EDITOR_SELECTOR);
  }

  function editorNearElement(element) {
    if (!(element instanceof Element)) return currentEditor || findPromptEditor();

    let container = element;
    while (container && container !== document.body) {
      const editor = findPromptEditor(container);
      if (editor) return editor;
      container = container.parentElement;
    }

    return currentEditor && currentEditor.isConnected
      ? currentEditor
      : findPromptEditor();
  }

  function isSendButton(button) {
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;

    const identifyingText = [
      button.getAttribute("aria-label"),
      button.getAttribute("data-tooltip"),
      button.getAttribute("data-test-id"),
      button.getAttribute("title"),
      button.className,
      button.textContent,
    ]
      .filter((value) => typeof value === "string")
      .join(" ");

    return /(^|[\s_-])(send|submit)([\s_-]|$)|送信|送る/i.test(identifyingText);
  }

  document.addEventListener(
    "keydown",
    (event) => {
      if (
        event.key !== "Enter" ||
        event.shiftKey ||
        event.isComposing ||
        event.keyCode === IME_PROCESSING_KEY_CODE ||
        event.repeat
      ) {
        return;
      }

      const editor = editorFromEventTarget(event.target);
      if (editor) appendLatestInfo(editor);
    },
    true
  );

  document.addEventListener(
    "click",
    (event) => {
      if (!(event.target instanceof Element)) return;
      const button = event.target.closest("button");
      if (isSendButton(button)) appendLatestInfo(editorNearElement(button));
    },
    true
  );

  document.addEventListener(
    "submit",
    (event) => {
      appendLatestInfo(editorNearElement(event.target));
    },
    true
  );

  const observer = new MutationObserver(scheduleMount);

  function start() {
    scheduleMount();
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });

  window.addEventListener("resize", scheduleMount);
  window.addEventListener("scroll", scheduleMount, true);
})();
