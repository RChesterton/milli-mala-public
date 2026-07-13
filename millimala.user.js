// ==UserScript==
// @name         Milli Mála
// @namespace    https://millimala.chesterton.is/
// @version      0.5.16
// @description  Ctrl+right-click Messenger messages to translate/explain; Ctrl+right-click composer to draft Icelandic locally. Inserts into your own composer only when you click Use. Never sends, reacts, or clicks Messenger.
// @updateURL    https://raw.githubusercontent.com/RChesterton/milli-mala-public/main/millimala.user.js
// @downloadURL  https://raw.githubusercontent.com/RChesterton/milli-mala-public/main/millimala.user.js
// @match        https://www.facebook.com/*
// @match        https://www.messenger.com/*
// @run-at       document-idle
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @connect      millimala.chesterton.is
// ==/UserScript==

(function () {
  "use strict";

  const CONFIG = {
    apiBase: "https://millimala.chesterton.is",
    maxMessageChars: 5000,
    trigger: {
      alt: false,
      ctrl: true,
      shift: false,
      meta: false
    },
    debug: false
  };

  // Printed once on load, so the running copy is always identifiable. During a debug cycle
  // inside one version, hand-over builds carry a "-dev.N" suffix; a bare version number
  // means this is the released artifact.
  const BUILD_ID = "0.5.16";

  const TOKEN_STORAGE_KEY = "rcmt_helper_token";
  const AUTH_POLL_INTERVAL_MS = 1000;
  const AUTH_POLL_MAX_ATTEMPTS = 120;
  const UNEXPECTED_ROUTE_RETRY_DELAY_MS = 400;
  const SELECTION_SYNC_TIMEOUT_MS = 50;
  const VIEWPORT_MARGIN = 12;
  const PANEL_GAP = 6;
  const COMPOSE_MIN_WIDTH = 270;
  const COMPOSE_MIN_HEIGHT = 220;
  // Block sending past this length (matches the helper's MAX_INPUT_CHARS backstop).
  // Real messages never approach it; this just prevents an over-long send gracefully
  // instead of the helper silently truncating.
  const MAX_INPUT_CHARS = 10000;

  const CLASS = {
    menu: "rc-local-translate-menu",
    menuButton: "rc-local-translate-menu-button",
    menuDivider: "rc-local-translate-menu-divider",
    panel: "rc-local-translate-panel",
    panelHeader: "rc-local-translate-panel-header",
    panelTitle: "rc-local-translate-panel-title",
    panelHeaderActions: "rc-local-translate-panel-header-actions",
    panelHeaderButton: "rc-local-translate-panel-header-button",
    panelBody: "rc-local-translate-panel-body",
    close: "rc-local-translate-close",
    error: "rc-local-translate-error",
    loading: "rc-local-translate-loading",
    compose: "rc-local-translate-compose",
    resizeHandle: "rc-local-translate-resize-handle",
    formRow: "rc-local-translate-form-row",
    textarea: "rc-local-translate-textarea",
    select: "rc-local-translate-select",
    button: "rc-local-translate-button",
    secondaryButton: "rc-local-translate-button-secondary",
    section: "rc-local-translate-section",
    pre: "rc-local-translate-pre",
    small: "rc-local-translate-small",
    breakdown: "rc-local-translate-breakdown",
    phrase: "rc-local-translate-phrase",
    alt: "rc-local-translate-alt",
    buttonRow: "rc-local-translate-button-row"
  };

  const TONES = [
    ["casual", "Casual"],
    ["serious", "Serious"],
    ["emotional", "Emotional"],
    ["sarcastic", "Sarcastic"],
    ["flirty", "Flirty"],
    ["warm", "Warm"],
    ["direct", "Direct"],
    ["playful", "Playful"]
  ];

  let activeContext = null;
  let activeMenu = null;
  let activePanel = null;

  function log(...args) {
    if (CONFIG.debug) console.log("[Milli Mála]", ...args);
  }

  function getStoredToken() {
    return String(GM_getValue(TOKEN_STORAGE_KEY, "") || "").trim();
  }

  function setStoredToken() {
    const current = getStoredToken();
    const value = window.prompt("Paste helper bearer token:", current);

    if (value === null) return;

    const trimmed = value.trim();
    if (!trimmed) {
      window.alert("Token was empty. Nothing changed.");
      return;
    }

    GM_setValue(TOKEN_STORAGE_KEY, trimmed);
    window.alert("Helper token saved in Tampermonkey storage.");
  }

  function clearStoredToken() {
    GM_setValue(TOKEN_STORAGE_KEY, "");
    window.alert("Helper token cleared from Tampermonkey storage.");
  }

  if (typeof GM_registerMenuCommand === "function") {
    GM_registerMenuCommand("Set helper token", setStoredToken);
    GM_registerMenuCommand("Clear helper token", clearStoredToken);
  }

  function h(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function copyText(text) {
    const value = String(text ?? "");
    if (!value) return;

    if (typeof GM_setClipboard === "function") {
      GM_setClipboard(value, "text");
    }
  }

  function cleanupOldInjectedUi() {
    document.getElementById("rc-local-translate-style")?.remove();

    for (const el of document.querySelectorAll(
      [
        ".rc-local-translate-toolbar",
        ".rc-local-translate-controls",
        ".rc-local-translate-result",
        `.${CLASS.menu}`,
        `.${CLASS.panel}`
      ].join(",")
    )) {
      el.remove();
    }
  }

  function injectStyles() {
    if (document.getElementById("rc-local-translate-style")) return;

    const style = document.createElement("style");
    style.id = "rc-local-translate-style";
    style.textContent = `
      .${CLASS.menu}, .${CLASS.panel}, .${CLASS.menu} *, .${CLASS.panel} * {
        box-sizing: border-box;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      .${CLASS.menu} {
        position: fixed;
        z-index: 2147483647;
        display: flex;
        flex-direction: column;
        min-width: 94px;
        overflow: hidden;
        border-radius: 10px;
        border: 1px solid rgba(255,255,255,0.16);
        background: rgba(28,28,30,0.98);
        color: white;
        box-shadow: 0 8px 28px rgba(0,0,0,0.42);
        font-size: 12px;
      }

      .${CLASS.menuButton} {
        border: 0;
        background: transparent;
        color: white;
        text-align: left;
        padding: 6px 9px;
        line-height: 1.1;
        font: inherit;
        cursor: pointer;
        user-select: none;
        white-space: nowrap;
      }

      .${CLASS.menuButton}:hover {
        background: rgba(255,255,255,0.12);
      }

      .${CLASS.menuButton}:disabled {
        opacity: 0.55;
        cursor: wait;
      }

      .${CLASS.menuDivider} {
        height: 1px;
        background: rgba(255,255,255,0.12);
        margin: 3px 0;
      }

      .${CLASS.panel} {
        position: fixed;
        z-index: 2147483647;
        min-width: min(150px, calc(100vw - 32px));
        max-width: min(520px, calc(100vw - 32px));
        max-height: min(460px, calc(100vh - 32px));
        overflow: hidden;
        border-radius: 12px;
        border: 1px solid rgba(255,255,255,0.16);
        background: rgba(28,28,30,0.96);
        color: white;
        box-shadow: 0 8px 28px rgba(0,0,0,0.42);
      }

      .${CLASS.panelHeader} {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 7px 9px;
        border-bottom: 1px solid rgba(255,255,255,0.12);
        font-size: 11px;
        font-weight: 600;
        opacity: 0.95;
        white-space: nowrap;
      }

      .${CLASS.panelTitle} {
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
      }

      .${CLASS.panelHeaderActions} {
        display: flex;
        align-items: center;
        gap: 6px;
        flex: 0 0 auto;
        white-space: nowrap;
      }

      .${CLASS.panelHeaderButton}, .${CLASS.close} {
        border: 0;
        background: transparent;
        color: white;
        cursor: pointer;
        line-height: 1;
        padding: 0 2px;
        opacity: 0.75;
      }

      .${CLASS.panelHeaderButton} {
        font-size: 11px;
        padding: 1px 3px;
      }

      .${CLASS.close} {
        font-size: 14px;
      }

      .${CLASS.panelHeaderButton}:hover, .${CLASS.close}:hover {
        opacity: 1;
      }

      .${CLASS.panelBody} {
        white-space: pre-wrap;
        overflow: auto;
        max-height: 390px;
        padding: 9px 10px;
        font-size: 12px;
        line-height: 1.38;
        overflow-wrap: anywhere;
      }

      .${CLASS.panel}.${CLASS.error} {
        border-color: rgba(255,90,90,0.45);
        background: rgba(55,20,20,0.96);
      }

      .${CLASS.panel}.${CLASS.loading} .${CLASS.panelBody} {
        max-height: none;
      }

      .${CLASS.panel}.${CLASS.compose} .${CLASS.panelBody} {
        white-space: normal;
        overflow: auto;
        font-size: 11px;
      }

      .${CLASS.panel}.${CLASS.compose} .${CLASS.panelHeader} {
        cursor: move;
        user-select: none;
        touch-action: none;
      }

      .${CLASS.resizeHandle} {
        position: absolute;
        right: 0;
        bottom: 0;
        width: 18px;
        height: 18px;
        cursor: nwse-resize;
        touch-action: none;
        z-index: 2;
      }

      .${CLASS.resizeHandle}::after {
        content: "";
        position: absolute;
        right: 4px;
        bottom: 4px;
        width: 8px;
        height: 8px;
        border-right: 2px solid rgba(255,255,255,0.55);
        border-bottom: 2px solid rgba(255,255,255,0.55);
      }

      .${CLASS.formRow} {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        margin-top: 8px;
      }

      .${CLASS.small} {
        color: rgba(255,255,255,0.72);
        font-size: 11px;
        line-height: 1.3;
      }

      .${CLASS.textarea}, .${CLASS.select} {
        border: 1px solid rgba(255,255,255,0.14);
        background: rgba(0,0,0,0.22);
        color: white;
        border-radius: 8px;
        font-size: 11px;
        line-height: 1.35;
        outline: none;
      }

      /* Starts ~2 lines tall and is auto-grown to fit the draft by autoSizeTextarea(). */
      .${CLASS.textarea} {
        display: block;
        width: 100%;
        min-height: 46px;
        max-height: 170px;
        resize: vertical;
        padding: 8px;
        margin-top: 0;
        white-space: pre-wrap;
      }

      .${CLASS.select} {
        min-width: 106px;
        padding: 0 6px;
      }

      /* Generate carries .secondaryButton, so it is already sized like Use/Copy. Match the
         Tone select to it: 11px text + 4px padding + 1px border, top and bottom. */
      .${CLASS.panel}.${CLASS.compose} .${CLASS.formRow} .${CLASS.select} {
        height: 21px;
        font-size: 11px;
        line-height: 1;
      }

      .${CLASS.button} {
        border: 1px solid rgba(255,255,255,0.16);
        background: rgba(255,255,255,0.12);
        color: white;
        border-radius: 8px;
        padding: 6px 8px;
        font-size: 12px;
        line-height: 1;
        cursor: pointer;
      }

      .${CLASS.button}:hover {
        background: rgba(255,255,255,0.18);
      }

      .${CLASS.button}:disabled {
        opacity: 0.55;
        cursor: wait;
      }

      .${CLASS.secondaryButton} {
        font-size: 11px;
        padding: 4px 6px;
      }

      .${CLASS.section} {
        margin-top: 9px;
        padding-top: 8px;
        border-top: 1px solid rgba(255,255,255,0.10);
      }

      .${CLASS.section}:first-child {
        margin-top: 0;
        padding-top: 0;
        border-top: 0;
      }

      .${CLASS.pre} {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }

      .${CLASS.breakdown} {
        display: grid;
        grid-template-columns: minmax(90px, 1fr) minmax(130px, 1.6fr);
        gap: 4px 8px;
      }

      .${CLASS.phrase} {
        font-weight: 600;
      }

      .${CLASS.alt} {
        margin-top: 7px;
        padding-top: 7px;
        border-top: 1px solid rgba(255,255,255,0.10);
      }

      /* The section rule already draws a divider above the first alternative;
         its own border would double it. */
      .${CLASS.alt}:first-child {
        margin-top: 0;
        padding-top: 0;
        border-top: 0;
      }

      .${CLASS.buttonRow} {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-top: 6px;
      }
    `;

    document.documentElement.appendChild(style);
  }

  function cleanText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }

  function compactText(value) {
    return cleanText(value).replace(/\s+/g, " ").trim();
  }

  function textFromElement(el) {
    return cleanText(el ? (el.innerText || el.textContent || "") : "");
  }

  function parseAriaMessage(label) {
    const text = cleanText(label);
    if (!text) return "";

    // Messenger labels are normally: "At <date/time>, <sender>: <message>".
    // The timestamp may contain colons (for example 19:59), so parse from the
    // final comma-before-sender rather than the first colon after "At".
    const match = text.match(/^At\s+[\s\S]*,\s+[^:\n]{1,180}:\s*([\s\S]+)$/i);
    if (match && match[1]) return cleanText(match[1]);

    return "";
  }

  function isProbablyMessageChrome(text) {
    const compact = compactText(text).toLowerCase();
    if (!compact) return true;
    if (compact === "message actions") return true;
    if (compact === "go to replied message") return true;
    if (compact.includes(" replied to ")) return true;
    if (compact.includes("reacted ")) return true;
    if (compact.includes("seen by ")) return true;
    return false;
  }

  function selectedTextInside(container) {
    const selection = window.getSelection ? window.getSelection() : null;
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return "";

    const parts = [];
    for (let i = 0; i < selection.rangeCount; i += 1) {
      const range = selection.getRangeAt(i);
      const ancestor = range.commonAncestorContainer;
      const owner = ancestor && ancestor.nodeType === Node.ELEMENT_NODE ? ancestor : ancestor?.parentElement;
      if (owner && container.contains(owner)) {
        parts.push(String(range.toString() || ""));
      }
    }

    const text = cleanText(parts.join("\n"));
    return text.length <= CONFIG.maxMessageChars ? text : "";
  }

  function addTextCandidate(candidates, el, targetEl, source) {
    if (!(el instanceof Element)) return;
    if (el.closest("button,[role='button'],a,[aria-label='Message actions'],[aria-label='Go to replied message']")) return;

    const text = textFromElement(el);
    if (!text || text.length > CONFIG.maxMessageChars) return;
    if (isProbablyMessageChrome(text)) return;

    let score = 0;
    if (el === targetEl) score += 120;
    if (targetEl instanceof Node && el.contains(targetEl)) score += 90;
    if (targetEl instanceof Element && targetEl.contains(el)) score += 80;
    if (source === "ancestor") score += 30;
    if (source === "descendant") score += 25;
    if (source === "near") score += 20;
    if (el.matches("span,div")) score += 10;
    if (/^H[1-6]$/.test(el.tagName)) score -= 80;
    if (text.length > 280) score -= 10;

    candidates.push({ el, text, score, length: text.length });
  }

  function findClickedMessageBodyElement(messageEl, targetEl) {
    if (!(messageEl instanceof Element) || !(targetEl instanceof Element) || !messageEl.contains(targetEl)) {
      return null;
    }

    const candidates = [];

    for (let el = targetEl; el && el instanceof Element && messageEl.contains(el); el = el.parentElement) {
      if (el.matches("[dir='auto']")) addTextCandidate(candidates, el, targetEl, "ancestor");
      if (el === messageEl) break;
    }

    for (const el of targetEl.querySelectorAll?.("[dir='auto']") || []) {
      if (messageEl.contains(el)) addTextCandidate(candidates, el, targetEl, "descendant");
    }

    for (const el of messageEl.querySelectorAll("[dir='auto']")) {
      if (el.contains(targetEl) || targetEl.contains(el)) {
        addTextCandidate(candidates, el, targetEl, "near");
      }
    }

    if (!candidates.length) return null;

    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.length - b.length;
    });

    return candidates[0].el;
  }

  function findCanonicalMessageBubble(messageEl, targetEl) {
    if (!(messageEl instanceof Element)) return null;

    const bodyEl = findClickedMessageBodyElement(messageEl, targetEl) ||
      (targetEl instanceof Element && messageEl.contains(targetEl) ? targetEl : messageEl);
    const candidates = [];

    for (let el = bodyEl; el && messageEl.contains(el); el = el.parentElement) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 12 || rect.height < 12 || rect.width > window.innerWidth * 0.9) {
        if (el === messageEl) break;
        continue;
      }

      const style = getComputedStyle(el);
      const radius = Math.max(
        parseFloat(style.borderTopLeftRadius) || 0,
        parseFloat(style.borderTopRightRadius) || 0,
        parseFloat(style.borderBottomLeftRadius) || 0,
        parseFloat(style.borderBottomRightRadius) || 0
      );
      const rolePresentation = el.getAttribute("role") === "presentation";
      const painted = style.backgroundColor !== "transparent" && style.backgroundColor !== "rgba(0, 0, 0, 0)";

      if (radius >= 8 && (rolePresentation || painted)) {
        candidates.push({ el, rolePresentation, painted, area: rect.width * rect.height });
      }

      if (el === messageEl) break;
    }

    candidates.sort((a, b) => {
      if (a.rolePresentation !== b.rolePresentation) return a.rolePresentation ? -1 : 1;
      if (a.painted !== b.painted) return a.painted ? -1 : 1;
      return a.area - b.area;
    });

    return candidates[0]?.el || bodyEl;
  }

  function extractFromClickedTarget(messageEl, targetEl) {
    const bodyEl = findClickedMessageBodyElement(messageEl, targetEl);
    return bodyEl ? textFromElement(bodyEl) : "";
  }

  function extractFromContainerFallback(messageEl) {
    const clone = messageEl.cloneNode(true);

    for (const el of clone.querySelectorAll(
      [
        `.${CLASS.menu}`,
        `.${CLASS.panel}`,
        "button",
        "[role='button']",
        "a",
        "[aria-label='Message actions']",
        "[aria-label='Go to replied message']"
      ].join(",")
    )) {
      el.remove();
    }

    return cleanText(clone.innerText || clone.textContent || "");
  }

  function extractMessageText(messageEl, targetEl = null) {
    const selected = selectedTextInside(messageEl);
    if (selected) return selected;

    const ariaText = parseAriaMessage(messageEl.getAttribute("aria-label"));
    if (ariaText) return ariaText;

    const clickedText = extractFromClickedTarget(messageEl, targetEl);
    if (clickedText) return clickedText;

    return extractFromContainerFallback(messageEl);
  }

  function extractComposerText(composerEl) {
    return cleanText(composerEl.innerText || composerEl.textContent || "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function isMessageElement(el) {
    if (!(el instanceof Element)) return false;

    if (!el.matches('[aria-roledescription="message"][data-message-id]')) {
      return false;
    }

    const text = extractMessageText(el, el);
    return text.length > 0 && text.length <= CONFIG.maxMessageChars;
  }

  function closestMessage(el) {
    if (!(el instanceof Element)) return null;

    const msg = el.closest('[aria-roledescription="message"][data-message-id]');
    return isMessageElement(msg) ? msg : null;
  }

  function closestComposer(el) {
    if (!(el instanceof Element)) return null;

    const editable = el.closest('[contenteditable="true"]');
    if (!editable) return null;

    if (editable.closest('[aria-roledescription="message"][data-message-id]')) return null;

    return editable;
  }

  function rectContainsRect(outer, inner) {
    return (
      outer.left <= inner.left + 1 &&
      outer.right >= inner.right - 1 &&
      outer.top <= inner.top + 1 &&
      outer.bottom >= inner.bottom - 1
    );
  }

  function normalizedBounds(rect) {
    const left = Math.max(VIEWPORT_MARGIN, rect.left);
    const right = Math.min(window.innerWidth - VIEWPORT_MARGIN, rect.right);
    const top = Math.max(VIEWPORT_MARGIN, rect.top);
    const bottom = Math.min(window.innerHeight - VIEWPORT_MARGIN, rect.bottom);

    return {
      left,
      right,
      top,
      bottom,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top)
    };
  }

  function viewportBounds() {
    const left = VIEWPORT_MARGIN;
    const right = window.innerWidth - VIEWPORT_MARGIN;
    const top = VIEWPORT_MARGIN;
    const bottom = window.innerHeight - VIEWPORT_MARGIN;

    return {
      left,
      right,
      top,
      bottom,
      width: right - left,
      height: bottom - top,
      isFallback: true,
      isPopup: false,
      isViewport: true
    };
  }

  function fallbackConversationBounds(anchorEl) {
    const rect = anchorEl.getBoundingClientRect();
    const left = Math.max(VIEWPORT_MARGIN, Math.min(rect.left - 360, window.innerWidth - 760));
    const right = Math.min(window.innerWidth - VIEWPORT_MARGIN, Math.max(rect.right + 360, left + 360));
    const top = VIEWPORT_MARGIN;
    const bottom = window.innerHeight - VIEWPORT_MARGIN;

    return {
      left,
      right,
      top,
      bottom,
      width: right - left,
      height: bottom - top,
      isFallback: true,
      isPopup: false
    };
  }

  function findConversationBounds(anchorEl) {
    if (!(anchorEl instanceof Element)) {
      const left = VIEWPORT_MARGIN;
      const right = window.innerWidth - VIEWPORT_MARGIN;
      const top = VIEWPORT_MARGIN;
      const bottom = window.innerHeight - VIEWPORT_MARGIN;
      return { left, right, top, bottom, width: right - left, height: bottom - top, isFallback: true, isPopup: false };
    }

    const anchorRect = anchorEl.getBoundingClientRect();
    let best = null;

    for (let el = anchorEl; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      const rect = el.getBoundingClientRect();

      if (rect.width < 280 || rect.height < 240) continue;
      if (rect.right < 0 || rect.left > window.innerWidth) continue;
      if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
      if (!rectContainsRect(rect, anchorRect)) continue;

      const bounds = normalizedBounds(rect);
      if (bounds.width < 260 || bounds.height < 220) continue;

      const rootLike = bounds.width > window.innerWidth * 0.94 && bounds.height > window.innerHeight * 0.90;
      const sidebarLike = bounds.left < 24 && bounds.width > window.innerWidth * 0.82;
      const area = bounds.width * bounds.height;
      const score = area + (rootLike ? 1e9 : 0) + (sidebarLike ? 5e8 : 0);

      if (!best || score < best.score) {
        best = { bounds, score };
      }
    }

    const bounds = best ? best.bounds : fallbackConversationBounds(anchorEl);
    bounds.isPopup = bounds.width <= 780 && bounds.height < window.innerHeight * 0.96;
    return bounds;
  }

  function isFullMessengerSurface() {
    const hostname = window.location.hostname.toLowerCase();
    const pathname = window.location.pathname.toLowerCase();
    return hostname === "www.messenger.com" || (hostname.endsWith("facebook.com") && pathname.startsWith("/messages"));
  }

  function clippedBounds(rect) {
    const left = Math.max(0, rect.left);
    const right = Math.min(window.innerWidth, rect.right);
    const top = Math.max(0, rect.top);
    const bottom = Math.min(window.innerHeight, rect.bottom);
    return {
      left,
      right,
      top,
      bottom,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top)
    };
  }

  function findMessengerNavigationBounds(chatBounds) {
    let best = null;

    for (const el of document.querySelectorAll('[role="navigation"]')) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 120 || rect.height < Math.max(240, window.innerHeight * 0.45)) continue;
      if (rect.right <= 0 || rect.left >= window.innerWidth || rect.bottom <= 0 || rect.top >= window.innerHeight) continue;
      if (chatBounds && rect.left >= chatBounds.left) continue;

      const bounds = clippedBounds(rect);
      const score = bounds.right - Math.abs((chatBounds?.left ?? bounds.right) - bounds.right) * 0.25;
      if (!best || score > best.score) best = { bounds, score };
    }

    return best ? best.bounds : null;
  }

  function findMessengerLayout(anchorEl) {
    if (!isFullMessengerSurface() || !(anchorEl instanceof Element)) return null;

    const main = anchorEl.closest('[role="main"]') ||
      Array.from(document.querySelectorAll('[role="main"]')).find(el => el.contains(anchorEl));
    if (!main) return null;

    let rowMatch = null;

    for (let childOnPath = anchorEl; childOnPath && childOnPath !== document.body; childOnPath = childOnPath.parentElement) {
      const row = childOnPath.parentElement;
      if (!row || !main.contains(row)) continue;

      const style = getComputedStyle(row);
      if (style.display !== "flex" || !style.flexDirection.startsWith("row")) continue;

      const rowRect = row.getBoundingClientRect();
      if (rowRect.width < 280 || rowRect.height < Math.max(280, window.innerHeight * 0.55)) continue;

      const chatEl = Array.from(row.children).find(el => el.contains(anchorEl));
      if (!(chatEl instanceof Element)) continue;

      const chatRect = chatEl.getBoundingClientRect();
      if (chatRect.width < 260 || chatRect.height < rowRect.height * 0.65) continue;

      const infoCandidates = Array.from(row.children)
        .filter(el => el !== chatEl)
        .map(el => ({ el, rect: el.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width >= 240 && rect.height >= rowRect.height * 0.55 && rect.left >= chatRect.right - 24 && rect.right > 0 && rect.left < window.innerWidth)
        .sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height);

      rowMatch = {
        row,
        chatEl,
        chat: clippedBounds(chatRect),
        infoEl: infoCandidates[0]?.el || null,
        info: infoCandidates[0] ? clippedBounds(infoCandidates[0].rect) : null
      };
    }

    if (!rowMatch) return null;

    rowMatch.navigation = findMessengerNavigationBounds(rowMatch.chat);
    return rowMatch;
  }

  function messengerFallbackRegion(layout) {
    if (!layout) return null;
    if (layout.info) return { ...layout.info, kind: "info" };
    if (layout.navigation) return { ...layout.navigation, kind: "navigation" };

    const right = Math.max(0, layout.chat.left - PANEL_GAP);
    if (right >= 180) {
      return { left: 0, right, top: 0, bottom: window.innerHeight, width: right, height: window.innerHeight, kind: "left-fallback" };
    }

    return null;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  // preferredMin is a small floor (buttons fit); the header.scrollWidth measurement
  // below is the real "fit the header items" width, and the body grows it only when
  // the text needs more. Start at header width, expand for content — not the reverse.
  function setPanelUsableWidth(panel, bounds, preferredMax = 520, preferredMin = 150) {
    const available = Math.max(preferredMin, bounds.width - 2 * VIEWPORT_MARGIN);
    const maxWidth = Math.max(preferredMin, Math.min(preferredMax, available));

    panel.style.maxWidth = Math.round(maxWidth) + "px";
    panel.style.minWidth = Math.round(Math.min(preferredMin, maxWidth)) + "px";

    const header = panel.querySelector("." + CLASS.panelHeader);
    if (header) {
      const needed = Math.ceil(header.scrollWidth + 10);
      const minWidth = Math.min(maxWidth, Math.max(preferredMin, needed));
      panel.style.minWidth = Math.round(minWidth) + "px";
    }
  }

  function sizePanelBody(panel, bodyHeight) {
    const body = panel.querySelector("." + CLASS.panelBody);
    if (!body) return;

    body.style.maxHeight = Math.max(120, Math.round(bodyHeight)) + "px";
    body.style.overflow = "auto";
  }

  function setPanelPosition(panel, left, top) {
    panel.style.left = Math.round(left) + "px";
    panel.style.top = Math.round(top) + "px";
  }

  function fitsHorizontally(left, width, bounds) {
    return left >= bounds.left + VIEWPORT_MARGIN && left + width <= bounds.right - VIEWPORT_MARGIN;
  }

  function placeElementInRegion(element, region, anchorRect, verticalMode = "near") {
    const rect = element.getBoundingClientRect();
    const left = region.left + Math.max(VIEWPORT_MARGIN, (region.width - rect.width) / 2);
    let top;

    if (verticalMode === "bottom") {
      top = region.bottom - rect.height - VIEWPORT_MARGIN;
    } else {
      top = anchorRect.top + anchorRect.height / 2 - rect.height / 2;
      top = clamp(top, region.top + VIEWPORT_MARGIN, region.bottom - rect.height - VIEWPORT_MARGIN);
    }

    setPanelPosition(element, left, top);
  }

  function createTranslationPlacement(messageEl, targetEl = null) {
    const messengerLayout = findMessengerLayout(messageEl);
    const detectedBounds = findConversationBounds(messageEl);
    const bubbleEl = messengerLayout
      ? findCanonicalMessageBubble(messageEl, targetEl)
      : messageEl;

    return {
      messengerLayout,
      detectedBounds,
      anchorRect: normalizedBounds((bubbleEl || messageEl).getBoundingClientRect())
    };
  }

  function placeTranslateMenu(menu, messageEl, targetEl = null, placement = null) {
    if (!menu.isConnected) document.body.appendChild(menu);

    const snapshot = placement || createTranslationPlacement(messageEl, targetEl);
    const { messengerLayout, detectedBounds } = snapshot;
    const bounds = messengerLayout?.chat || (detectedBounds.isPopup ? viewportBounds() : detectedBounds);
    const rect = snapshot.anchorRect;
    const menuRect = menu.getBoundingClientRect();

    if (messengerLayout) {
      const left = Math.max(VIEWPORT_MARGIN, rect.left - menuRect.width - PANEL_GAP);
      let top = rect.top + rect.height / 2 - menuRect.height / 2;
      top = clamp(top, bounds.top + VIEWPORT_MARGIN, bounds.bottom - menuRect.height - VIEWPORT_MARGIN);
      setPanelPosition(menu, left, top);
      return;
    }

    const mid = messengerLayout
      ? bounds.left + bounds.width / 2
      : detectedBounds.isPopup
      ? rect.left + rect.width / 2
      : bounds.left + bounds.width / 2;
    const isLeftMessage = rect.left + rect.width / 2 < mid;

    const preferredLeft = isLeftMessage ? rect.right + PANEL_GAP : rect.left - menuRect.width - PANEL_GAP;
    const oppositeLeft = isLeftMessage ? rect.left - menuRect.width - PANEL_GAP : rect.right + PANEL_GAP;
    const fitsPreferred = fitsHorizontally(preferredLeft, menuRect.width, bounds);
    const fitsOpposite = fitsHorizontally(oppositeLeft, menuRect.width, bounds);

    if (messengerLayout && !fitsPreferred && !fitsOpposite) {
      const region = messengerFallbackRegion(messengerLayout);
      if (region) {
        placeElementInRegion(menu, region, rect);
        return;
      }
    }

    let left = fitsPreferred ? preferredLeft : fitsOpposite ? oppositeLeft : preferredLeft;
    left = clamp(left, bounds.left + VIEWPORT_MARGIN, bounds.right - menuRect.width - VIEWPORT_MARGIN);

    let top = rect.top + rect.height / 2 - menuRect.height / 2;
    top = clamp(top, bounds.top + VIEWPORT_MARGIN, bounds.bottom - menuRect.height - VIEWPORT_MARGIN);

    setPanelPosition(menu, left, top);
  }

  function placeTranslatePanel(panel, messageEl, targetEl = null, placement = null) {
    if (!panel.isConnected) document.body.appendChild(panel);

    const snapshot = placement || createTranslationPlacement(messageEl, targetEl);
    const { messengerLayout, detectedBounds, anchorRect } = snapshot;

    if (detectedBounds.isPopup) {
      const bounds = viewportBounds();
      const availableLeft = Math.max(0, detectedBounds.left - PANEL_GAP - VIEWPORT_MARGIN);
      const availableRight = Math.max(0, window.innerWidth - detectedBounds.right - PANEL_GAP - VIEWPORT_MARGIN);
      const useLeft = availableLeft >= 240 || availableLeft >= availableRight;
      const sideAvailable = Math.max(220, useLeft ? availableLeft : availableRight);

      setPanelUsableWidth(panel, bounds, Math.min(420, sideAvailable));
      panel.style.maxHeight = Math.round(Math.min(360, detectedBounds.height, bounds.height - 2 * VIEWPORT_MARGIN)) + "px";
      sizePanelBody(panel, Math.min(290, detectedBounds.height - 70, bounds.height - 80));

      let panelRect = panel.getBoundingClientRect();
      let panelWidth = Math.min(panelRect.width, sideAvailable, bounds.width - 2 * VIEWPORT_MARGIN);
      const panelHeight = Math.min(panelRect.height, bounds.height - 2 * VIEWPORT_MARGIN);

      if (panelRect.width > sideAvailable && sideAvailable >= 220) {
        panel.style.maxWidth = Math.round(sideAvailable) + "px";
        panel.style.minWidth = Math.round(Math.min(sideAvailable, 240)) + "px";
        panelRect = panel.getBoundingClientRect();
        panelWidth = Math.min(panelRect.width, sideAvailable, bounds.width - 2 * VIEWPORT_MARGIN);
      }

      const left = useLeft
        ? clamp(detectedBounds.left - panelWidth - PANEL_GAP, bounds.left + VIEWPORT_MARGIN, detectedBounds.left - PANEL_GAP)
        : clamp(detectedBounds.right + PANEL_GAP, detectedBounds.right + PANEL_GAP, bounds.right - panelWidth - VIEWPORT_MARGIN);
      const top = clamp(
        anchorRect.top + anchorRect.height / 2 - panelHeight / 2,
        Math.max(bounds.top + VIEWPORT_MARGIN, detectedBounds.top),
        Math.min(bounds.bottom - panelHeight - VIEWPORT_MARGIN, detectedBounds.bottom - panelHeight)
      );

      setPanelPosition(panel, left, top);
      return;
    }

    const bounds = messengerLayout?.chat || detectedBounds;

    if (messengerLayout) {
      const leftAvailable = Math.max(220, anchorRect.left - PANEL_GAP - VIEWPORT_MARGIN);
      const widthBounds = {
        left: VIEWPORT_MARGIN,
        right: anchorRect.left - PANEL_GAP,
        top: bounds.top,
        bottom: bounds.bottom,
        width: leftAvailable,
        height: bounds.height
      };

      setPanelUsableWidth(panel, widthBounds, Math.min(420, leftAvailable), 220);
      panel.style.maxHeight = Math.round(Math.min(460, bounds.height - 2 * VIEWPORT_MARGIN)) + "px";
      sizePanelBody(panel, Math.min(390, bounds.height - 80));

      const panelRect = panel.getBoundingClientRect();
      const panelWidth = Math.min(panelRect.width, leftAvailable);
      const panelHeight = Math.min(panelRect.height, bounds.height - 2 * VIEWPORT_MARGIN);
      const left = Math.max(VIEWPORT_MARGIN, anchorRect.left - panelWidth - PANEL_GAP);
      let top = anchorRect.top + anchorRect.height / 2 - panelHeight / 2;
      top = clamp(top, bounds.top + VIEWPORT_MARGIN, bounds.bottom - panelHeight - VIEWPORT_MARGIN);

      setPanelPosition(panel, left, top);
      return;
    }

    setPanelUsableWidth(panel, bounds, 520);
    panel.style.maxHeight = Math.round(Math.min(460, bounds.height - 2 * VIEWPORT_MARGIN)) + "px";
    sizePanelBody(panel, Math.min(390, bounds.height - 80));

    let panelRect = panel.getBoundingClientRect();
    const panelWidth = Math.min(panelRect.width, bounds.width - 2 * VIEWPORT_MARGIN);
    const panelHeight = Math.min(panelRect.height, bounds.height - 2 * VIEWPORT_MARGIN);
    const paneMid = bounds.left + bounds.width / 2;
    const isLeftMessage = anchorRect.left + anchorRect.width / 2 < paneMid;

    const preferredLeft = isLeftMessage
      ? anchorRect.right + PANEL_GAP
      : anchorRect.left - panelWidth - PANEL_GAP;
    const oppositeLeft = isLeftMessage
      ? anchorRect.left - panelWidth - PANEL_GAP
      : anchorRect.right + PANEL_GAP;

    let left = preferredLeft;
    const fitsPreferred = fitsHorizontally(left, panelWidth, bounds);
    const fitsOpposite = fitsHorizontally(oppositeLeft, panelWidth, bounds);

    if (!fitsPreferred && fitsOpposite) {
      left = oppositeLeft;
    } else if (!fitsPreferred && messengerLayout) {
      const region = messengerFallbackRegion(messengerLayout);
      if (region) {
        setPanelUsableWidth(panel, region, Math.max(220, Math.min(520, region.width - 2 * VIEWPORT_MARGIN)));
        panel.style.maxHeight = Math.round(Math.max(160, Math.min(460, region.height - 2 * VIEWPORT_MARGIN))) + "px";
        sizePanelBody(panel, Math.max(120, Math.min(390, region.height - 80)));
        placeElementInRegion(panel, region, anchorRect);
        return;
      }
      left = anchorRect.left + anchorRect.width / 2 - panelWidth / 2;
    } else if (!fitsPreferred) {
      left = anchorRect.left + anchorRect.width / 2 - panelWidth / 2;
    }

    left = clamp(left, bounds.left + VIEWPORT_MARGIN, bounds.right - panelWidth - VIEWPORT_MARGIN);

    let top = anchorRect.top + anchorRect.height / 2 - panelHeight / 2;
    if (top < bounds.top + VIEWPORT_MARGIN) top = anchorRect.bottom + PANEL_GAP;
    if (top + panelHeight > bounds.bottom - VIEWPORT_MARGIN) top = anchorRect.top - panelHeight - PANEL_GAP;
    top = clamp(top, bounds.top + VIEWPORT_MARGIN, bounds.bottom - panelHeight - VIEWPORT_MARGIN);

    panelRect = panel.getBoundingClientRect();
    setPanelPosition(panel, left, top);
  }

  function composerCentralBounds(composerEl, detectedBounds) {
    const rect = composerEl.getBoundingClientRect();
    const leftGutter = Math.min(260, Math.max(160, Math.round(rect.width * 0.45)));
    let left = Math.max(detectedBounds.left, rect.left - leftGutter);
    let right = Math.min(detectedBounds.right, rect.right + 48);

    if (right - left < 520) {
      left = Math.max(detectedBounds.left, right - 620);
    }

    if (right - left < 360) {
      left = detectedBounds.left;
      right = detectedBounds.right;
    }

    return {
      ...detectedBounds,
      left,
      right,
      width: right - left
    };
  }

  function findPopupFrameBounds(anchorEl, fallbackBounds) {
    if (!(anchorEl instanceof Element)) return fallbackBounds;

    const anchorRect = anchorEl.getBoundingClientRect();
    let best = null;

    for (let el = anchorEl; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 280 || rect.width > 520) continue;
      if (rect.height < Math.max(260, fallbackBounds.height - 2) || rect.height > window.innerHeight) continue;
      if (!rectContainsRect(rect, anchorRect)) continue;

      const style = getComputedStyle(el);
      const radius = Math.max(
        parseFloat(style.borderTopLeftRadius) || 0,
        parseFloat(style.borderTopRightRadius) || 0,
        parseFloat(style.borderBottomLeftRadius) || 0,
        parseFloat(style.borderBottomRightRadius) || 0
      );
      const painted = style.backgroundColor !== "transparent" && style.backgroundColor !== "rgba(0, 0, 0, 0)";
      const shadowed = style.boxShadow && style.boxShadow !== "none";

      if (painted && radius >= 6 && shadowed && style.overflow === "hidden") {
        const bounds = normalizedBounds(rect);
        bounds.isPopup = true;
        return bounds;
      }
    }

    for (let childOnPath = anchorEl; childOnPath && childOnPath !== document.body; childOnPath = childOnPath.parentElement) {
      const row = childOnPath.parentElement;
      if (!row || row === document.body || row === document.documentElement) continue;

      const rowStyle = getComputedStyle(row);
      const rowRect = row.getBoundingClientRect();
      const childRect = childOnPath.getBoundingClientRect();
      const fixedPopupRow = rowStyle.position === "fixed" && rowStyle.display === "flex" && rowStyle.flexDirection.startsWith("row");

      if (
        fixedPopupRow &&
        rowRect.width >= childRect.width &&
        childRect.width >= 280 && childRect.width <= 520 &&
        childRect.height >= 260 && childRect.height <= window.innerHeight &&
        rectContainsRect(childRect, anchorRect)
      ) {
        const bounds = normalizedBounds(childRect);
        bounds.isPopup = true;
        return bounds;
      }
    }

    for (let el = anchorEl; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 280 || rect.width > 520) continue;
      if (rect.height < Math.max(260, fallbackBounds.height) || rect.height > window.innerHeight) continue;
      if (rect.right < 0 || rect.left > window.innerWidth) continue;
      if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
      if (!rectContainsRect(rect, anchorRect)) continue;

      const style = getComputedStyle(el);
      const fixedLike = style.position === "fixed" || style.position === "sticky";
      const area = rect.width * rect.height;
      const score = area + (fixedLike ? 1e8 : 0);

      if (!best || score > best.score) {
        best = { rect, score };
      }
    }

    const bounds = best ? normalizedBounds(best.rect) : fallbackBounds;
    bounds.isPopup = true;
    return bounds;
  }

  function placeComposePanel(panel, composerEl) {
    if (!panel.isConnected) document.body.appendChild(panel);

    if (panel.__rcComposeInteraction?.manual) {
      syncComposePanelBody(panel);
      return;
    }

    const messengerLayout = findMessengerLayout(composerEl);
    const detectedBounds = findConversationBounds(composerEl);
    const margin = VIEWPORT_MARGIN;
    const isFacebookPopup = !isFullMessengerSurface() && detectedBounds.isPopup;
    const popupBounds = isFacebookPopup ? findPopupFrameBounds(composerEl, detectedBounds) : null;
    let bounds = isFacebookPopup ? viewportBounds() : composerCentralBounds(composerEl, detectedBounds);
    let width;
    let height;
    let left;
    let top;

    if (isFacebookPopup) {
      const popup = popupBounds || detectedBounds;
      const availableLeft = Math.max(0, popup.left - PANEL_GAP - margin);
      width = Math.max(COMPOSE_MIN_WIDTH, Math.min(440, availableLeft));
      height = Math.max(260, Math.min(popup.height, window.innerHeight - 2 * margin));
      left = popup.left - width - PANEL_GAP;
      top = popup.top;
    } else if (messengerLayout) {
      const region = messengerFallbackRegion(messengerLayout);

      if (region) {
        bounds = region;
        const availableWidth = Math.max(180, region.width - 2 * margin);
        width = Math.min(430, availableWidth);
        height = Math.min(420, Math.max(COMPOSE_MIN_HEIGHT, region.height - 2 * margin));
        left = region.left + Math.max(margin, (region.width - width) / 2);
        top = region.bottom - height - margin;
      } else {
        bounds = messengerLayout.chat;
        width = Math.max(COMPOSE_MIN_WIDTH, Math.min(430, bounds.width - 2 * margin));
        height = Math.max(260, Math.min(420, bounds.height - 2 * margin));
        left = bounds.left + margin;
        top = bounds.bottom - height - margin;
      }
    } else {
      width = Math.max(340, Math.min(430, Math.round(bounds.width * 0.50), bounds.width - 2 * margin));
      height = Math.max(260, Math.min(420, Math.round(bounds.height * 0.42), bounds.height - 2 * margin));
      left = bounds.right - width - margin;
      top = bounds.top + Math.min(64, Math.max(margin, bounds.height - height - margin));
    }

    if (!isFacebookPopup) {
      left = clamp(left, bounds.left + margin, bounds.right - width - margin);
      top = clamp(top, bounds.top + margin, bounds.bottom - height - margin);
    }

    panel.style.width = Math.round(width) + "px";
    panel.style.minWidth = Math.round(Math.min(width, COMPOSE_MIN_WIDTH)) + "px";
    panel.style.maxWidth = Math.round(width) + "px";
    panel.style.height = Math.round(height) + "px";
    panel.style.minHeight = Math.round(Math.min(height, COMPOSE_MIN_HEIGHT)) + "px";
    panel.style.maxHeight = Math.round(height) + "px";

    syncComposePanelBody(panel);
    setPanelPosition(panel, left, top);
  }

  function syncComposePanelBody(panel) {
    const header = panel.querySelector("." + CLASS.panelHeader);
    const headerHeight = header ? header.getBoundingClientRect().height : 34;
    const panelHeight = panel.getBoundingClientRect().height || parseFloat(panel.style.height) || 420;
    sizePanelBody(panel, panelHeight - headerHeight);
  }

  function enableComposeDragResize(panel) {
    const header = panel.querySelector("." + CLASS.panelHeader);
    if (!header || panel.__rcComposeInteraction) return;

    const state = { manual: false };
    panel.__rcComposeInteraction = state;

    const beginPointerInteraction = (event, mode) => {
      if (event.button !== 0) return;
      if (mode === "drag" && event.target instanceof Element && event.target.closest("button")) return;

      event.preventDefault();
      event.stopPropagation();

      const startRect = panel.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      state.manual = true;

      panel.style.left = Math.round(startRect.left) + "px";
      panel.style.top = Math.round(startRect.top) + "px";
      panel.style.width = Math.round(startRect.width) + "px";
      panel.style.height = Math.round(startRect.height) + "px";

      if (mode === "resize") {
        panel.style.maxWidth = "none";
        panel.style.maxHeight = "none";
        panel.style.minWidth = COMPOSE_MIN_WIDTH + "px";
        panel.style.minHeight = COMPOSE_MIN_HEIGHT + "px";
      }

      const move = moveEvent => {
        if (moveEvent.pointerId !== event.pointerId) return;
        moveEvent.preventDefault();
        moveEvent.stopPropagation();

        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;

        if (mode === "drag") {
          panel.style.left = Math.round(startRect.left + dx) + "px";
          panel.style.top = Math.round(startRect.top + dy) + "px";
        } else {
          panel.style.width = Math.round(Math.max(COMPOSE_MIN_WIDTH, startRect.width + dx)) + "px";
          panel.style.height = Math.round(Math.max(COMPOSE_MIN_HEIGHT, startRect.height + dy)) + "px";
          syncComposePanelBody(panel);
        }
      };

      const end = endEvent => {
        if (endEvent.pointerId !== event.pointerId) return;
        document.removeEventListener("pointermove", move, true);
        document.removeEventListener("pointerup", end, true);
        document.removeEventListener("pointercancel", end, true);
      };

      document.addEventListener("pointermove", move, true);
      document.addEventListener("pointerup", end, true);
      document.addEventListener("pointercancel", end, true);
    };

    header.addEventListener("pointerdown", event => beginPointerInteraction(event, "drag"));
    header.addEventListener("dragstart", event => event.preventDefault());

    const resizeHandle = document.createElement("div");
    resizeHandle.className = CLASS.resizeHandle;
    resizeHandle.title = "Resize";
    resizeHandle.setAttribute("aria-label", "Resize compose panel");
    resizeHandle.addEventListener("pointerdown", event => beginPointerInteraction(event, "resize"));
    panel.appendChild(resizeHandle);
  }

  function helperErrorFromResponse(status, json, fallback) {
    const message = json && json.error ? json.error : (fallback || `HTTP ${status}`);
    const err = new Error(message);
    err.status = status;
    err.errorClass = json && json.error_class ? json.error_class : "";
    err.actions = json && Array.isArray(json.actions) ? json.actions : [];
    err.provider = json && json.provider ? json.provider : null;
    return err;
  }

  function parseHelperJson(text, status) {
    try {
      return JSON.parse(text || "{}");
    } catch (err) {
      const invalid = new Error(`Invalid helper response: ${err.message}`);
      invalid.status = status;
      invalid.errorClass = "invalid_helper_response";
      throw invalid;
    }
  }

  // A genuine helper reply is always a JSON object/array. A body that starts with
  // anything else (typically an HTML gateway/proxy/error page) is not JSON — surface a
  // clear gateway error instead of a raw "Unexpected token '<'" parse failure. This is
  // deliberately NOT an auth signal: Cloudflare Access re-auth is detected only on the
  // GM onerror/status-0 path (isCloudflareAccessAuthRequiredFromGm), never here.
  function bodyLooksLikeJsonContainer(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return true; // empty body is handled as {} by parseHelperJson
    const first = trimmed[0];
    return first === "{" || first === "[";
  }

  function nonJsonHelperError(status, text) {
    const trimmed = String(text || "").trim();
    const looksHtml = /^<(?:!doctype|html|head|body|\?xml|\/)/i.test(trimmed) || trimmed.startsWith("<");
    const kind = looksHtml
      ? "an HTML page (likely a gateway, proxy, or access error page)"
      : "a non-JSON response";
    const err = new Error(`Milli Mála helper returned ${kind} instead of JSON (HTTP ${status || "unknown"}). This is usually a temporary gateway or proxy problem — wait a moment and try again.`);
    err.status = status;
    err.errorClass = looksHtml ? "gateway_html_response" : "non_json_response";
    return err;
  }

  function sleep(ms) {
    return new Promise(resolve => window.setTimeout(resolve, ms));
  }

  function isCloudflareAccessAuthRequiredFromGm(error) {
    const status = Number(error && typeof error.status !== "undefined" ? error.status : NaN);
    const text = [
      error && error.error,
      error && error.statusText,
      error && error.responseText
    ].map(value => String(value || "").toLowerCase()).join("\n");

    return status === 0 && (
      text.includes("redirected to a not whitelisted url") ||
      text.includes("cloudflareaccess.com") ||
      text.includes("/cdn-cgi/access/login")
    );
  }

  function gmContactError(source) {
    if (isCloudflareAccessAuthRequiredFromGm(source)) {
      const err = new Error("Milli Mála authentication is required. Complete the auth tab and Milli Mála will retry automatically.");
      err.status = 0;
      err.errorClass = "cloudflare_access_auth_required";
      err.authRequired = true;
      return err;
    }

    const err = new Error("Could not contact translation helper.");
    if (source && typeof source.status !== "undefined") err.status = source.status;
    err.errorClass = "gm_request_error";
    return err;
  }

  function gmRequest(method, path, options = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url: CONFIG.apiBase + path,
        headers: options.headers || {},
        data: options.data,
        timeout: options.timeout || 30000,

        onload(response) {
          resolve(response);
        },

        onerror(error) {
          reject(gmContactError(error));
        },

        ontimeout() {
          reject(new Error("Helper request timed out."));
        },

        onabort() {
          reject(new Error("Helper request was aborted."));
        }
      });
    });
  }

  async function callApiGmOnce(path, payload, timeout, token) {
    const response = await gmRequest("POST", path, {
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + token
      },
      data: JSON.stringify(payload),
      timeout
    });

    const body = response.responseText || "{}";

    if (!bodyLooksLikeJsonContainer(body)) {
      log("non_json_helper_response", response.status);
      throw nonJsonHelperError(response.status, body);
    }

    const json = parseHelperJson(body, response.status);

    if (response.status < 200 || response.status >= 300 || !json.ok) {
      throw helperErrorFromResponse(response.status, json);
    }

    return json;
  }

  function openHealthAuthTab() {
    const url = CONFIG.apiBase + "/health";

    try {
      if (typeof GM_openInTab === "function") {
        return GM_openInTab(url, { active: true, insert: true, setParent: true });
      }
    } catch (err) {
      log("auth_tab_open_failed");
    }

    try {
      return window.open(url, "_blank", "noopener");
    } catch (err) {
      log("auth_tab_open_failed");
      return null;
    }
  }

  async function checkHealthGm(timeout = 8000) {
    const response = await gmRequest("GET", "/health", {
      headers: {
        "Accept": "application/json"
      },
      timeout
    });

    const json = parseHelperJson(response.responseText || "{}", response.status);

    if (response.status < 200 || response.status >= 300 || !json.ok || json.service !== "millimala") {
      throw helperErrorFromResponse(response.status, json, "Health check did not return Milli Mála helper status.");
    }

    return json;
  }

  let activeAuthPromise = null;

  async function recoverAccessAuth() {
    if (activeAuthPromise) return activeAuthPromise;

    activeAuthPromise = recoverAccessAuthOnce().finally(() => {
      activeAuthPromise = null;
    });

    return activeAuthPromise;
  }

  async function recoverAccessAuthOnce() {
    if (navigator && navigator.onLine === false) {
      throw new Error("Browser appears to be offline.");
    }

    log("cloudflare_access_auth_required");

    const authTab = openHealthAuthTab();
    if (!authTab) {
      throw new Error("Milli Mála could not open the authentication tab. Allow pop-ups and try again.");
    }

    log("auth_poll_started");

    for (let attempt = 1; attempt <= AUTH_POLL_MAX_ATTEMPTS; attempt += 1) {
      await sleep(AUTH_POLL_INTERVAL_MS);

      try {
        await checkHealthGm(8000);

        let closeFailed = false;
        try {
          if (authTab && typeof authTab.close === "function") {
            authTab.close();
          } else {
            closeFailed = true;
          }
        } catch (err) {
          closeFailed = true;
        }

        if (closeFailed) log("auth_tab_close_failed");
        log("auth_poll_success");

        return { closeFailed };
      } catch {
        // Auth is still pending or the health request is still blocked by Access.
      }
    }

    log("auth_poll_timeout");
    throw new Error("Milli Mála auth was not completed within 2 minutes. Try again.");
  }

  function withNotice(response, notice) {
    const current = String(response && response.notice ? response.notice : "").trim();
    return {
      ...response,
      notice: current ? `${current}\n${notice}` : notice
    };
  }

  // A 404 or 405 from /translate or /compose is impossible in normal operation — those routes
  // always exist and the userscript always POSTs. Seen once (2026-07-11) as a GET the userscript
  // never sent, meaning something turned the POST into a GET and dropped the body. Cause unknown,
  // so this treats the symptom only.
  // Deliberately NOT wired into the Cloudflare Access path: that keys off status 0, and
  // disturbing it would break external auth recovery.
  function isUnexpectedRouteFailure(err) {
    const status = Number(err && err.status);
    return status === 404 || status === 405;
  }

  function unexpectedRouteError(status) {
    const err = new Error("Milli Mála couldn't reach the helper properly. Please try again.");
    err.status = status;
    err.errorClass = "unexpected_route_failure";
    return err;
  }

  // Retries at most ONCE, then gives up. `retry` is a shared flag, not a counter, so a route
  // failure after auth recovery cannot start a second round.
  async function callApiGmGuarded(path, payload, timeout, token, retry) {
    try {
      return await callApiGmOnce(path, payload, timeout, token);
    } catch (err) {
      if (!isUnexpectedRouteFailure(err)) throw err;
      if (retry.used) throw unexpectedRouteError(err.status);

      retry.used = true;
      await sleep(UNEXPECTED_ROUTE_RETRY_DELAY_MS);

      try {
        return await callApiGmOnce(path, payload, timeout, token);
      } catch (retryErr) {
        if (!isUnexpectedRouteFailure(retryErr)) throw retryErr;
        throw unexpectedRouteError(retryErr.status);
      }
    }
  }

  async function callApi(path, payload, timeout) {
    const token = getStoredToken();

    if (!token) {
      throw new Error("No helper token saved. Use Tampermonkey menu → Set helper token.");
    }

    const retry = { used: false };

    try {
      return await callApiGmGuarded(path, payload, timeout, token, retry);
    } catch (err) {
      if (!err || !err.authRequired) throw err;
    }

    const recovery = await recoverAccessAuth();

    try {
      const response = await callApiGmGuarded(path, payload, timeout, token, retry);
      if (recovery && recovery.closeFailed) {
        return withNotice(response, "Auth complete. Translation retried. You may close the auth tab.");
      }
      return response;
    } catch (err) {
      if (err && err.authRequired) {
        throw new Error("Milli Mála authentication is still required. Try again.");
      }
      throw err;
    }
  }

  // `provider` selects a provider explicitly ("vertex"); the mode string is unchanged, because the
  // helper derives the prompt from the +/- suffix. Empty means the normal AGY-first chain.
  function postTranslate(mode, model, text, providerAction = "", provider = "") {
    const timeout = mode.endsWith("+") || model === "high" ? 240000 : 160000;
    return callApi("/translate", { mode, model, text, providerAction, provider }, timeout);
  }

  function postCompose(tone, text, providerAction = "", provider = "") {
    return callApi("/compose", { model: "low", tone, text, providerAction, provider }, 240000);
  }

  function closeMenu() {
    if (activeMenu) {
      activeMenu.remove();
      activeMenu = null;
    }
  }

  function closePanel() {
    if (activePanel) {
      activePanel.remove();
      activePanel = null;
    }
  }

  function closeAll() {
    closeMenu();
    closePanel();
  }

  function createPanel(anchorEl, title, isError = false) {
    closePanel();

    const panel = document.createElement("div");
    panel.className = CLASS.panel;
    if (isError) panel.classList.add(CLASS.error);

    const header = document.createElement("div");
    header.className = CLASS.panelHeader;

    const titleEl = document.createElement("div");
    titleEl.className = CLASS.panelTitle;
    titleEl.textContent = title;

    const actions = document.createElement("div");
    actions.className = CLASS.panelHeaderActions;

    const closeButton = document.createElement("button");
    closeButton.className = CLASS.close;
    closeButton.type = "button";
    closeButton.textContent = "×";
    closeButton.title = "Close";

    closeButton.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      closePanel();
    });

    actions.appendChild(closeButton);
    header.appendChild(titleEl);
    header.appendChild(actions);

    const body = document.createElement("div");
    body.className = CLASS.panelBody;

    panel.appendChild(header);
    panel.appendChild(body);

    activePanel = panel;
    document.body.appendChild(panel);

    return { panel, header, actions, body };
  }

  function showTextPanel(anchorEl, title, text, isError = false, copyValue = "", extraClass = "", targetEl = null, placement = null) {
    const { panel, actions, body } = createPanel(anchorEl, title, isError);

    if (extraClass) panel.classList.add(extraClass);

    body.textContent = text;

    if (copyValue) {
      const copyButton = document.createElement("button");
      copyButton.className = CLASS.panelHeaderButton;
      copyButton.type = "button";
      copyButton.textContent = "Copy";
      copyButton.title = "Copy";
      copyButton.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        copyText(copyValue);
      });
      actions.insertBefore(copyButton, actions.firstChild);
    }

    placeTranslatePanel(panel, anchorEl, targetEl, placement);
  }

  function showError(anchorEl, title, err, targetEl = null, placement = null) {
    showTextPanel(anchorEl, title, err && err.message ? err.message : String(err), true, "", "", targetEl, placement);
  }

  function helperActions(err) {
    return err && Array.isArray(err.actions) ? err.actions.filter(action => action && action.id && action.label) : [];
  }

  function showActionError(anchorEl, title, err, onAction, targetEl = null, placement = null) {
    const actions = helperActions(err);
    if (!actions.length) {
      showError(anchorEl, title, err, targetEl, placement);
      return;
    }

    const { panel, body } = createPanel(anchorEl, title, true);
    const message = document.createElement("div");
    message.className = CLASS.pre;
    message.textContent = err && err.message ? err.message : String(err);
    body.appendChild(message);

    const section = document.createElement("div");
    section.className = CLASS.section;

    for (const action of actions) {
      const button = document.createElement("button");
      button.className = `${CLASS.button} ${CLASS.secondaryButton}`;
      button.type = "button";
      button.textContent = action.label;
      button.title = action.label;
      button.style.marginRight = "6px";
      button.style.marginTop = "6px";
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        onAction(action, button);
      });
      section.appendChild(button);
    }

    body.appendChild(section);
    placeTranslatePanel(panel, anchorEl, targetEl, placement);
  }

  function addMenuButton(menu, label, title, action) {
    const button = document.createElement("button");
    button.className = CLASS.menuButton;
    button.type = "button";
    button.textContent = label;
    button.title = title;

    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      action(button);
    });

    menu.appendChild(button);
    return button;
  }

  function addMenuDivider(menu) {
    const divider = document.createElement("div");
    divider.className = CLASS.menuDivider;
    menu.appendChild(divider);
  }

  function showTranslateMenu(messageEl, targetEl) {
    closeMenu();

    const placement = createTranslationPlacement(messageEl, targetEl);
    activeContext = { messageEl, targetEl, placement };

    const menu = document.createElement("div");
    menu.className = CLASS.menu;

    addMenuButton(menu, "EN-", "Translate to English with GPT-OSS", button => {
      translateActiveMessage("EN-", "low", "EN-", button);
    });

    addMenuButton(menu, "EN", "Translate to English", button => {
      translateActiveMessage("EN", "low", "EN", button);
    });

    // (V) = same prompt, same mode, but routed to Vertex AI. Deliberately paired with its non-Vertex
    // twin so the two are directly comparable on quality, speed and cost.
    addMenuButton(menu, "EN (V)", "Translate to English via Vertex AI", button => {
      translateActiveMessage("EN", "low", "EN (V)", button, "", "vertex");
    });

    addMenuButton(menu, "EN+", "Translate to English and break down", button => {
      translateActiveMessage("EN+", "low", "EN+", button);
    });

    addMenuButton(menu, "EN+ (V)", "Translate to English and break down via Vertex AI", button => {
      translateActiveMessage("EN+", "low", "EN+ (V)", button, "", "vertex");
    });

    addMenuDivider(menu);

    addMenuButton(menu, "IS-", "Translate to Icelandic with GPT-OSS", button => {
      translateActiveMessage("IS-", "low", "IS-", button);
    });

    addMenuButton(menu, "IS", "Translate to Icelandic", button => {
      translateActiveMessage("IS", "low", "IS", button);
    });

    addMenuButton(menu, "IS (V)", "Translate to Icelandic via Vertex AI", button => {
      translateActiveMessage("IS", "low", "IS (V)", button, "", "vertex");
    });

    addMenuButton(menu, "IS+", "Translate to Icelandic and break down", button => {
      translateActiveMessage("IS+", "low", "IS+", button);
    });

    addMenuButton(menu, "IS+ (V)", "Translate to Icelandic and break down via Vertex AI", button => {
      translateActiveMessage("IS+", "low", "IS+ (V)", button, "", "vertex");
    });

    menu.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
    });

    activeMenu = menu;
    placeTranslateMenu(menu, messageEl, targetEl, placement);
  }

  async function translateActiveMessage(mode, model, label, button, providerAction = "", provider = "") {
    const context = activeContext;
    const messageEl = context && context.messageEl;
    const targetEl = context && context.targetEl;
    const placement = context && context.placement;
    if (!messageEl) return;

    const text = extractMessageText(messageEl, targetEl);

    closeMenu();

    if (!text) {
      showTextPanel(messageEl, label, "No message text found.", true, "", "", targetEl, placement);
      return;
    }

    if (!messageEl.__rcLocalTranslateCache) {
      messageEl.__rcLocalTranslateCache = {};
    }

    // `provider` belongs in the key: EN and EN (V) share a mode and text but must never serve each
    // other's cached result — comparing them is the point of the (V) buttons.
    const cacheKey = `${mode}:${model}:${provider}:${providerAction}:${text}`;

    if (messageEl.__rcLocalTranslateCache[cacheKey]) {
      const cachedText = messageEl.__rcLocalTranslateCache[cacheKey];
      showTextPanel(messageEl, label, cachedText, false, cachedText, "", targetEl, placement);
      return;
    }

    const originalButtonText = button ? button.textContent : "";

    try {
      if (button) {
        button.disabled = true;
        button.textContent = "Translating…";
      }

      showTextPanel(
        messageEl,
        label,
        "Translating…",
        false,
        "",
        CLASS.loading,
        targetEl,
        placement
      );

      const response = await postTranslate(mode, model, text, providerAction, provider);
      const resultText = String(response.text || "");
      const noticeText = String(response.notice || "").trim();
      const displayText = noticeText ? `${noticeText}\n\n${resultText}` : resultText;

      messageEl.__rcLocalTranslateCache[cacheKey] = resultText;

      const modelLabel = response.cached ? "cached" : (response.modelName || response.model || model);
      showTextPanel(messageEl, `${label} · ${modelLabel}`, displayText, false, resultText, "", targetEl, placement);
    } catch (err) {
      if (helperActions(err).length) {
        showActionError(messageEl, `${label} error`, err, (action, actionButton) => {
          // Keep the provider on a retry: an alternate offered by a Vertex failure is a Vertex model.
          translateActiveMessage(mode, model, label, actionButton, action.id, provider);
        }, targetEl, placement);
      } else {
        showError(messageEl, `${label} error`, err, targetEl, placement);
      }
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = originalButtonText;
      }
    }
  }

  function renderBreakdownHtml(items) {
    if (!Array.isArray(items) || !items.length) {
      return `<div class="${CLASS.small}">No breakdown returned.</div>`;
    }

    return `
      <div class="${CLASS.breakdown}">
        ${items.map(item => `
          <div class="${CLASS.phrase}">${h(item && item.phrase)}</div>
          <div>${h(item && item.meaning)}</div>
        `).join("")}
      </div>
    `;
  }

  function renderComposeResultHtml(data) {
    const alternatives = Array.isArray(data.alternatives) ? data.alternatives : [];

    const altHtml = alternatives.length
      ? alternatives.map((alt, index) => {
          const text = typeof alt === "string" ? alt : String((alt && alt.text) || "");
          const english = typeof alt === "string" ? "" : String((alt && alt.english) || "");
          const notes = typeof alt === "string" ? "" : String((alt && alt.notes) || "");
          const breakdown = typeof alt === "string" ? [] : alt && alt.breakdown;

          return `
            <div class="${CLASS.alt}">
              <div class="${CLASS.small}">Alternative ${index + 1}</div>
              <div class="${CLASS.pre}">${h(text)}</div>
              ${english ? `<div class="${CLASS.small}" style="margin-top:5px">${h(english)}</div>` : ""}
              ${Array.isArray(breakdown) && breakdown.length ? `<div style="margin-top:6px">${renderBreakdownHtml(breakdown)}</div>` : ""}
              ${notes && notes.trim() ? `<div class="${CLASS.small}" style="margin-top:5px">${h(notes)}</div>` : ""}
              <div class="${CLASS.buttonRow}">
                <button type="button" class="${CLASS.button} ${CLASS.secondaryButton}" data-rc-use-alt="${index}">Use</button>
                <button type="button" class="${CLASS.button} ${CLASS.secondaryButton}" data-rc-copy-alt="${index}">Copy</button>
              </div>
            </div>
          `;
        }).join("")
      : `<div class="${CLASS.small}">No alternatives returned.</div>`;

    return `
      ${data.notice ? `
        <div class="${CLASS.section}">
          <div class="${CLASS.small}">Notice</div>
          <div class="${CLASS.pre}">${h(data.notice)}</div>
        </div>
      ` : ""}

      <div class="${CLASS.section}">
        <div class="${CLASS.small}">Sendable text</div>
        <div class="${CLASS.pre}">${h(data.text || "")}</div>
        <div class="${CLASS.buttonRow}">
          <button type="button" class="${CLASS.button} ${CLASS.secondaryButton}" data-rc-use-main>Use</button>
          <button type="button" class="${CLASS.button} ${CLASS.secondaryButton}" data-rc-copy-main>Copy</button>
        </div>
      </div>

      ${data.english ? `
        <div class="${CLASS.section}">
          <div class="${CLASS.small}">English</div>
          <div class="${CLASS.pre}">${h(data.english)}</div>
        </div>
      ` : ""}

      <div class="${CLASS.section}">
        <div class="${CLASS.small}">Breakdown</div>
        ${renderBreakdownHtml(data.breakdown)}
      </div>

      <div class="${CLASS.section}">
        ${altHtml}
      </div>

      ${data.notes && String(data.notes).trim() ? `
        <div class="${CLASS.section}">
          <div class="${CLASS.small}">Notes</div>
          <div class="${CLASS.pre}">${h(data.notes)}</div>
        </div>
      ` : ""}
    `;
  }

  // The ONLY function in Milli Mála that writes into a Facebook/Messenger element.
  //
  // U1a — never auto-send. Structurally guaranteed, not merely intended:
  //   - dispatches NO keyboard events (no Enter, no keydown/keypress/keyup);
  //   - calls .click() on NO page element, dispatches no submit;
  //   - uses only insertText — never insertParagraph/insertLineBreak.
  // No path through here can reach a send. Richard presses Send himself.
  //
  // Writes ONLY to the composer node handed to showComposePanel (the one that was
  // Ctrl-right-clicked). It must never search the document for a composer: the first
  // contenteditable on a Facebook page is often a public comment box, and writing
  // there would be a privacy incident.
  async function insertIntoComposer(composerEl, text) {
    const value = String(text || "");

    // Insertion failing is abnormal and the user only sees "Copied instead" — say why.
    const reject = reason => {
      console.warn("[Milli Mála] Use: composer insert rejected —", reason);
      return false;
    };

    if (!value) return reject("no text to insert");
    if (!(composerEl instanceof Element)) return reject("composer reference is not an element");
    if (!composerEl.isConnected) return reject("composer node is no longer in the page (React replaced it)");
    if (!composerEl.isContentEditable) return reject("target is not contenteditable");

    // Whether there was anything to replace. An empty composer legitimately yields a collapsed
    // selection later, and that must not be treated as a failure — see the guard below.
    const hadText = Boolean(String(composerEl.innerText || "").trim());

    // Focus is mandatory: without it execCommand silently no-ops.
    composerEl.focus();

    // Lexical restores its own caret in its focus handler, which wipes a selection set in the
    // same tick — that is why a select-all done immediately after focus() is silently collapsed
    // to the end of the existing text and the insert then does nothing. Yield a frame so our
    // selection is the last word.
    await new Promise(resolve => requestAnimationFrame(resolve));

    if (composerEl !== document.activeElement && !composerEl.contains(document.activeElement)) {
      return reject("composer did not take focus");
    }

    const selection = window.getSelection();
    if (!selection) return reject("no selection object available");

    // Select the composer's own contents — and nothing else on the page — so that insertText
    // replaces the draft rather than appending to it.
    //
    // Lexical keeps its own selection state and only learns about a programmatic DOM range via
    // the ASYNCHRONOUS selectionchange event. Firing execCommand in the same tick means Lexical
    // still holds its stale caret, so its beforeinput handler preventDefault()s, wipes our
    // selection and writes nothing. Wait for selectionchange to actually land first.
    await new Promise(resolve => {
      const settle = () => {
        document.removeEventListener("selectionchange", settle);
        window.clearTimeout(timer);
        resolve();
      };

      const timer = window.setTimeout(settle, SELECTION_SYNC_TIMEOUT_MS);
      document.addEventListener("selectionchange", settle);

      const range = document.createRange();
      range.selectNodeContents(composerEl);
      selection.removeAllRanges();
      selection.addRange(range);
    });

    // Refuse to type anywhere outside the intended composer.
    if (!composerEl.contains(selection.anchorNode)) return reject("selection landed outside the composer");

    // A collapsed selection is only a FAILURE if there was text to select. An EMPTY composer has
    // nothing to select, so the selection is legitimately collapsed — and insertText at a collapsed
    // caret is exactly right. The old unconditional guard rejected that case and fell back to the
    // clipboard, so "Use" silently refused to work whenever the composer was empty.
    // The guard still does its real job: catching Lexical DESTROYING a selection we did make.
    if (selection.isCollapsed && hadText) {
      return reject("editor collapsed the selection before insert");
    }

    document.execCommand("insertText", false, value);

    // execCommand returns true even when a rich-text editor discards the result,
    // so verify against the DOM rather than trusting the return value.
    const normalise = candidate => String(candidate || "").replace(/\s+/g, " ").trim();
    if (!normalise(composerEl.innerText).includes(normalise(value))) {
      return reject("editor discarded the text (execCommand claimed success)");
    }

    return true;
  }

  function flashButton(button, label) {
    const original = button.dataset.rcLabel || button.textContent;
    button.dataset.rcLabel = original;
    button.textContent = label;

    window.setTimeout(() => {
      if (button.isConnected) button.textContent = button.dataset.rcLabel || original;
    }, 1200);
  }

  // If the composer rejected the insert, fall back to the clipboard and say so, so there
  // is never a dead button with no way to get the text out.
  async function useText(button, value, composerEl) {
    if (await insertIntoComposer(composerEl, value)) {
      flashButton(button, "Inserted ✓");
      return;
    }

    copyText(value);
    flashButton(button, "Copied instead ✓");
  }

  function altText(alt) {
    if (typeof alt === "string") return alt;
    return alt && alt.text ? String(alt.text) : "";
  }

  function wireComposeResultButtons(container, data, composerEl) {
    const alternatives = Array.isArray(data.alternatives) ? data.alternatives : [];

    const bind = (button, value, handler) => {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        handler(button, value);
      });
    };

    const useMain = container.querySelector("[data-rc-use-main]");
    if (useMain) {
      bind(useMain, String(data.text || ""), (button, value) => useText(button, value, composerEl));
    }

    const copyMain = container.querySelector("[data-rc-copy-main]");
    if (copyMain) {
      bind(copyMain, String(data.text || ""), (button, value) => {
        copyText(value);
        flashButton(button, "Copied ✓");
      });
    }

    for (const button of container.querySelectorAll("[data-rc-use-alt]")) {
      const index = Number(button.getAttribute("data-rc-use-alt"));
      bind(button, altText(alternatives[index]), (target, value) => useText(target, value, composerEl));
    }

    for (const button of container.querySelectorAll("[data-rc-copy-alt]")) {
      const index = Number(button.getAttribute("data-rc-copy-alt"));
      bind(button, altText(alternatives[index]), (target, value) => {
        copyText(value);
        flashButton(target, "Copied ✓");
      });
    }
  }

  function renderHelperActionErrorHtml(err) {
    const actions = helperActions(err);

    return `
      <div class="${CLASS.pre}">${h(err && err.message ? err.message : err)}</div>
      ${actions.length ? `
        <div class="${CLASS.section}">
          ${actions.map(action => `
            <button
              type="button"
              class="${CLASS.button} ${CLASS.secondaryButton}"
              data-rc-provider-action="${h(action.id)}"
              style="margin-top:6px;margin-right:6px"
            >${h(action.label)}</button>
          `).join("")}
        </div>
      ` : ""}
    `;
  }

  function wireHelperActionButtons(container, onAction) {
    for (const button of container.querySelectorAll("[data-rc-provider-action]")) {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        onAction(button.getAttribute("data-rc-provider-action") || "", button);
      });
    }
  }

  function showComposePanel(composerEl) {
    const initialText = extractComposerText(composerEl);
    const { body } = createPanel(composerEl, "Write Icelandic", false);

    activePanel.classList.add(CLASS.compose);

    body.innerHTML = `
      <div class="${CLASS.section}">
        <textarea class="${CLASS.textarea}" data-rc-compose-text>${h(initialText)}</textarea>
        <div class="${CLASS.small}" data-rc-compose-warning style="display:none;margin-top:4px;color:#ff5a5a"></div>
      </div>

      <div class="${CLASS.formRow}">
        <select class="${CLASS.select}" data-rc-compose-tone>
          ${TONES.map(([value, label]) => `<option value="${h(value)}">${h(label)}</option>`).join("")}
        </select>

        <button type="button" class="${CLASS.button} ${CLASS.secondaryButton}" data-rc-compose-generate>Generate</button>
        <button type="button" class="${CLASS.button} ${CLASS.secondaryButton}" data-rc-compose-vertex>Vertex</button>
      </div>

      <div class="${CLASS.section}" data-rc-compose-output></div>
    `;

    placeComposePanel(activePanel, composerEl);
    enableComposeDragResize(activePanel);

    const textEl = body.querySelector("[data-rc-compose-text]");
    const toneEl = body.querySelector("[data-rc-compose-tone]");
    const generateEl = body.querySelector("[data-rc-compose-generate]");
    const vertexEl = body.querySelector("[data-rc-compose-vertex]");
    const warningEl = body.querySelector("[data-rc-compose-warning]");
    const outputEl = body.querySelector("[data-rc-compose-output]");

    // Grow the draft box to fit its content so the text read from the composer is fully
    // visible on open, rather than reserving a fixed block of empty height. CSS min-height
    // floors it at ~2 lines and max-height caps it, after which the textarea scrolls.
    function autoSizeTextarea() {
      textEl.style.height = "auto";
      textEl.style.height = `${textEl.scrollHeight}px`;
    }

    // Block sending an over-long draft: grey out both send buttons and warn, instead of
    // letting the helper silently truncate. Recomputed on every edit.
    function refreshComposeLimit() {
      const length = String(textEl.value || "").length;
      const overLimit = length > MAX_INPUT_CHARS;
      generateEl.disabled = overLimit;
      if (vertexEl) vertexEl.disabled = overLimit;
      if (warningEl) {
        warningEl.style.display = overLimit ? "" : "none";
        warningEl.textContent = overLimit
          ? `Too long to send: ${length.toLocaleString()} / ${MAX_INPUT_CHARS.toLocaleString()} characters. Shorten it to generate.`
          : "";
      }
      return overLimit;
    }

    textEl.addEventListener("input", () => {
      autoSizeTextarea();
      refreshComposeLimit();
    });

    autoSizeTextarea();
    refreshComposeLimit();

    // Generate and Vertex differ only by which provider the helper is told to use. Same prompt,
    // same tone, same draft — so the two outputs are directly comparable.
    async function startCompose(provider) {
      if (refreshComposeLimit()) return;

      const text = String(textEl.value || "").trim();
      const tone = String(toneEl.value || "casual");
      if (!text) {
        outputEl.innerHTML = `<div class="${CLASS.pre}">No composer text found.</div>`;
        placeComposePanel(activePanel, composerEl);
        return;
      }

      const renderComposeError = err => {
        outputEl.innerHTML = renderHelperActionErrorHtml(err);
        wireHelperActionButtons(outputEl, async (providerAction, actionButton) => {
          const originalActionText = actionButton.textContent;
          try {
            actionButton.disabled = true;
            actionButton.textContent = "Generating…";
            await runCompose(providerAction);
          } finally {
            if (actionButton.isConnected) {
              actionButton.disabled = false;
              actionButton.textContent = originalActionText;
            }
          }
        });
        placeComposePanel(activePanel, composerEl);
      };

      // An alternate offered by a Vertex failure is a Vertex model, so `provider` rides along.
      const runCompose = async (providerAction = "") => {
        try {
          const response = await postCompose(tone, text, providerAction, provider);
          outputEl.innerHTML = renderComposeResultHtml(response);
          wireComposeResultButtons(outputEl, response, composerEl);
          placeComposePanel(activePanel, composerEl);
        } catch (err) {
          renderComposeError(err);
        }
      };

      generateEl.disabled = true;
      if (vertexEl) vertexEl.disabled = true;
      outputEl.innerHTML = `<div class="${CLASS.pre}">Generating…</div>`;
      placeComposePanel(activePanel, composerEl);

      try {
        await runCompose();
      } finally {
        generateEl.disabled = false;
        if (vertexEl) vertexEl.disabled = false;
        refreshComposeLimit();
      }
    }

    generateEl.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      startCompose("");
    });

    if (vertexEl) {
      vertexEl.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        startCompose("vertex");
      });
    }
  }

  function start() {
    console.info("[Milli Mála] build", BUILD_ID, "loaded");

    cleanupOldInjectedUi();
    injectStyles();

    document.addEventListener("contextmenu", event => {
      // Milli Mála only handles exact Ctrl-right-click.
      // Normal right-click and Alt-right-click are returned immediately and are not prevented.
      const exactCtrlRightClick =
        event.button === 2 &&
        event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        !event.metaKey;

      if (!exactCtrlRightClick) {
        return;
      }

      const target = event.target instanceof Element ? event.target : null;
      if (!target) {
        return;
      }

      const composer = closestComposer(target);
      const message = composer ? null : closestMessage(target);

      if (!composer && !message) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      if (composer) {
        closeMenu();
        showComposePanel(composer);
        return;
      }

      showTranslateMenu(message, target);
    }, true);

    document.addEventListener("mousedown", event => {
      // Only a plain left mouse button outside-click closes Milli Mála.
      // Right-click, Alt-right-click, Ctrl-right-click, and other modified clicks are ignored completely here.
      if (event.button !== 0 || event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) {
        return;
      }

      if (
        event.target instanceof Element &&
        (activeMenu?.contains(event.target) || activePanel?.contains(event.target))
      ) {
        return;
      }

      closeAll();
    }, true);

    document.addEventListener("scroll", () => {
      closeMenu();
    }, true);

    document.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        closeAll();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
