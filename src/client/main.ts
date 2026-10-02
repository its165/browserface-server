[Reading 1266 lines from start (total: 1266 lines, 0 remaining)]

import type { ModifierKey, MouseButton, ServerMessage } from "../shared/protocol.js";
import { createBridge } from "./bridge.js";
import { setupFindBar } from "./find-bar.js";
import { setupPasteHelper } from "./paste-helper.js";
import { setupStatusBar } from "./statusbar.js";
import { setupTabs } from "./tabs.js";
import { setupToolbar } from "./toolbar.js";
import { setupTouch } from "./touch.js";

interface Viewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
}

const els = {
  tabs: document.getElementById("tabs") as HTMLElement,
  back: document.getElementById("back") as HTMLButtonElement,
  forward: document.getElementById("forward") as HTMLButtonElement,
  reload: document.getElementById("reload") as HTMLButtonElement,
  urlForm: document.getElementById("url-form") as HTMLFormElement,
  url: document.getElementById("url") as HTMLInputElement,
  openExternal: document.getElementById("open-external") as HTMLButtonElement,
  focusMode: document.getElementById("focus-mode") as HTMLButtonElement,
  fullscreen: document.getElementById("fullscreen") as HTMLButtonElement,
  focusExit: document.getElementById("focus-exit") as HTMLButtonElement,
  status: document.getElementById("status") as HTMLSpanElement,
  loadingIndicator: document.getElementById("loading-indicator") as HTMLSpanElement,
  fps: document.getElementById("fps") as HTMLSpanElement,
  hoverLink: document.getElementById("hover-link") as HTMLAnchorElement,
  stage: document.getElementById("stage") as HTMLElement,
  frame: document.getElementById("frame") as HTMLDivElement,
  screen: document.getElementById("screen") as HTMLImageElement,
  placeholder: document.getElementById("placeholder") as HTMLDivElement,
  inactiveOverlay: document.getElementById("inactive-overlay") as HTMLDivElement,
  inactiveRevive: document.getElementById("inactive-revive") as HTMLButtonElement,
  inactiveCancel: document.getElementById("inactive-cancel") as HTMLButtonElement,
  toast: document.getElementById("toast") as HTMLDivElement,
  pasteHelper: document.getElementById("paste-helper") as HTMLInputElement,
  findBar: document.getElementById("find-bar") as HTMLDivElement,
  findInput: document.getElementById("find-input") as HTMLInputElement,
  findCount: document.getElementById("find-count") as HTMLSpanElement,
  findPrev: document.getElementById("find-prev") as HTMLButtonElement,
  findNext: document.getElementById("find-next") as HTMLButtonElement,
  findClose: document.getElementById("find-close") as HTMLButtonElement,
  orientToggle: document.getElementById("orient-toggle") as HTMLButtonElement,
  sidebarResize: document.getElementById("sidebar-resize") as HTMLDivElement,
  tabSidebar: document.getElementById("tab-sidebar") as HTMLElement,
  vpMatchSize: document.getElementById("vp-match-size") as HTMLButtonElement,
  vpDesktopSize: document.getElementById("vp-desktop-size") as HTMLButtonElement,
};

let viewport: Viewport = { width: 1280, height: 800, deviceScaleFactor: 1 };
let isVisible = true;
let activeTabId: string | null = null;
// Mirrors whether the remote has an editable input/textarea focused, kept
// in sync with the latest selection message. Drives helper focus on touch:
// on coarse-pointer devices we only want the OS keyboard up when there's
// somewhere to type, not on every tap.
let remoteHasField = false;
// Whether the remote's tracked mouse position is currently over an
// editable target — text-type input, textarea, or contenteditable.
// Updated from `hover` messages. The touch handler reads this on
// touchend to decide whether to focus the paste helper inside the
// gesture, popping the OS keyboard for editable targets only. Distinct
// from `cursor === 'text'` because plain page text glyphs also produce
// the I-beam cursor without being editable.
let lastCursorEditable = false;
// True between a touchstart-dispatched hover probe and the matching
// hover response — i.e., we don't yet know what the user just tapped.
// On a tap that lands while still in flight, the touch handler
// speculatively force-focuses the helper so a slow probe doesn't
// cost the user a second tap on a real field. The selection-handler
// blur path dismisses the keyboard ~100ms later if the click turned
// out to be on a non-editable. Net: every field works first-tap;
// non-editable taps only flash when the probe is unusually slow.
let probeInFlight = false;

// Keep only the newest incoming frame until the next paint. At 60 FPS this
// prevents screenshot packets from monopolizing the local main thread.
let pendingFrameUrl: string | null = null;
let frameRenderScheduled = false;
function scheduleFrameRender(url: string) {
  if (pendingFrameUrl) URL.revokeObjectURL(pendingFrameUrl);
  pendingFrameUrl = url;
  if (frameRenderScheduled) return;
  frameRenderScheduled = true;
  requestAnimationFrame(() => {
    frameRenderScheduled = false;
    const next = pendingFrameUrl;
    pendingFrameUrl = null;
    if (!next) return;
    const previous = els.screen.dataset.blobUrl;
    els.screen.src = next;
    els.screen.dataset.blobUrl = next;
    if (previous) URL.revokeObjectURL(previous);
  });
}

const isCoarsePointer =
  typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;

function fitFrame() {
  // Sets the framed image element to the largest size that fits the stage,
  // preserving the aspect ratio of the remote viewport. The status bar lives
  // inside the stage now (so it can sit flush below the frame), so we need to
  // subtract its measured height from the available vertical space.
  const statusbar = document.querySelector(".statusbar") as HTMLElement | null;
  const statusH = statusbar ? statusbar.offsetHeight : 0;
  const availW = els.stage.clientWidth;
  const availH = els.stage.clientHeight - statusH;
  const aspect = viewport.width / viewport.height;
  let w = availW;
  let h = w / aspect;
  if (h > availH) {
    h = availH;
    w = h * aspect;
  }
  els.frame.style.width = `${Math.max(0, Math.floor(w))}px`;
  els.frame.style.height = `${Math.max(0, Math.floor(h))}px`;
}

function pointToViewport(e: { clientX: number; clientY: number }): { x: number; y: number } {
  const rect = els.frame.getBoundingClientRect();
  const xRatio = (e.clientX - rect.left) / rect.width;
  const yRatio = (e.clientY - rect.top) / rect.height;
  return {
    x: Math.max(0, Math.min(viewport.width, xRatio * viewport.width)),
    y: Math.max(0, Math.min(viewport.height, yRatio * viewport.height)),
  };
}

function modifiersFromEvent(e: KeyboardEvent | MouseEvent | WheelEvent): ModifierKey[] {
  const mods: ModifierKey[] = [];
  if (e.altKey) mods.push("Alt");
  if (e.ctrlKey) mods.push("Control");
  if (e.metaKey) mods.push("Meta");
  if (e.shiftKey) mods.push("Shift");
  return mods;
}

function handleServerMessage(msg: ServerMessage) {
  switch (msg.type) {
    case "ready":
      viewport = msg.viewport;
      toolbar.setUrl(msg.url);
      document.title = msg.title ? `${msg.title} — browserface` : "browserface";
      fitFrame();
      return;
    case "screenshot": {
      const viewportChanged =
        viewport.width !== msg.width ||
        viewport.height !== msg.height ||
        viewport.deviceScaleFactor !== msg.deviceScaleFactor;

      viewport = {
        width: msg.width,
        height: msg.height,
        deviceScaleFactor: msg.deviceScaleFactor,
      };
      const mime = msg.format === "png" ? "image/png" : "image/jpeg";

      // Coalesce binary frames to the next paint; stale frames are
      // disposable and should never build local decode/render pressure.
      if (typeof msg.data === "string") {
        els.screen.src = "data:" + mime + ";base64," + msg.data;
      } else {
        const nextUrl = URL.createObjectURL(
          new Blob([new Uint8Array(msg.data)], { type: mime }),
        );
        scheduleFrameRender(nextUrl);
      }

      els.placeholder.classList.add("hidden");
      // If frames are arriving, the tab is alive — clear any stale inactive prompt.
      tabs.hideInactive();
      statusBar.recordFrame();
      if (viewportChanged) fitFrame();
      return;
    }
    case "page":
      toolbar.setUrl(msg.url);
      document.title = msg.title ? `${msg.title} — browserface` : "browserface";
      statusBar.setLoading(msg.loading);
      return;
    case "tabs": {
      // Find state (cached ranges, highlights, count) belongs to the page
      // we attached to. Switching tabs invalidates all of it, so close the
      // bar — the user can re-open with Cmd-F on the new tab.
      const nextActive = msg.tabs.find((t) => t.active)?.id ?? null;
      if (activeTabId !== null && nextActive !== activeTabId && findBar.isVisible()) {
        findBar.hide();
      }
      activeTabId = nextActive;
      tabs.setTabs(msg.tabs);
      const tabCount = document.getElementById("mobile-tab-count");
      if (tabCount) tabCount.textContent = String(msg.tabs.length);
      return;
    }
    case "visibility":
      if (msg.visible !== isVisible) {
        isVisible = msg.visible;
        document.body.classList.toggle("out-of-focus", !isVisible);
        tabs.setVisibility(msg.visible);
      }
      return;
    case "inactive":
      tabs.showInactive();
      return;
    case "hover":
      statusBar.setHoverLink(msg.href);
      // Mirror the remote's cursor on the screencast frame so hovering a
      // link shows pointer, an input shows the I-beam, etc.
      els.frame.style.cursor = msg.cursor || "default";
      lastCursorEditable = !!msg.editable;
      probeInFlight = false;
      return;
    case "selection":
      pasteHelper.setRemoteState({ text: msg.text, field: msg.field });
      // `editable` is the superset signal: input/textarea (which also set
      // `field`) AND contenteditable subtrees (which don't, because their
      // value/selection model doesn't fit the field tuple). Track this
      // separately so the mobile keyboard pops for ChatGPT-style
      // contenteditable composers, not just plain inputs.
      remoteHasField = !!msg.editable;
      // On coarse-pointer devices, sync the OS keyboard with the remote's
      // focused-field state. iOS leaves a transient user-activation window
      // open for ~5s after a tap, so a selection message that arrives
      // ~100ms later (the cdp-session selection-poll throttle) can still
      // pop the keyboard from a programmatic focus call. Blur on no-field
      // dismisses the keyboard when the user taps a non-editable area.
      // Desktop is unchanged — the helper stays focused unconditionally
      // there because it's the clipboard anchor.
      if (isCoarsePointer) {
        if (remoteHasField) pasteHelper.focus();
        else pasteHelper.blur();
      }
      return;
    case "findResult":
      findBar.setResult(msg.current, msg.total);
      return;
    case "error":
      console.warn("[bridge] server error:", msg.message);
      showToast(msg.message);
      return;
    case "ack":
      return;
  }
}

const statusBar = setupStatusBar({
  status: els.status,
  loadingIndicator: els.loadingIndicator,
  fps: els.fps,
  hoverLink: els.hoverLink,
});
const bridge = createBridge({
  setStatus: statusBar.setStatus,
  onMessage: handleServerMessage,
});
const pasteHelper = setupPasteHelper({
  el: els.pasteHelper,
  send: bridge.send,
  isUrlBarFocused: () => document.activeElement === els.url,
});
// Re-anchor focus on the paste helper after another input gives it up
// (URL bar, find bar). On coarse pointers we suppress the call when the
// remote isn't on an editable field, so dismissing the URL bar on mobile
// doesn't immediately re-pop the OS keyboard via the helper.
function refocusPasteHelper() {
  if (!isCoarsePointer || remoteHasField) pasteHelper.focus();
}
const tabs = setupTabs({
  tabsEl: els.tabs,
  sidebarEl: els.tabSidebar,
  inactiveOverlay: els.inactiveOverlay,
  inactiveRevive: els.inactiveRevive,
  inactiveCancel: els.inactiveCancel,
  send: bridge.send,
  // After any tab switch / new-tab, dismiss the mobile overlay sidebar so
  // the user lands back on the page they just selected without an extra
  // tap to close. No-op on desktop or when the sidebar isn't open.
  onTabAction: () => closeMobileSidebar(),
  // Match Chrome's Cmd+T: when the user clicks "+", focus the URL bar
  // empty so they can type immediately.
  onNewTab: () => toolbar.focusUrl(),
});
const toolbar = setupToolbar({
  back: els.back,
  forward: els.forward,
  reload: els.reload,
  urlForm: els.urlForm,
  url: els.url,
  openExternal: els.openExternal,
  send: bridge.send,
  onUrlBlur: refocusPasteHelper,
});
const findBar = setupFindBar({
  bar: els.findBar,
  input: els.findInput,
  count: els.findCount,
  prevBtn: els.findPrev,
  nextBtn: els.findNext,
  closeBtn: els.findClose,
  send: bridge.send,
  onClose: refocusPasteHelper,
});
bridge.connect();

// ── Immersive controls ───────────────────────────────────────────────────────
const FOCUS_KEY = "browserface:focus";
let focusMode = localStorage.getItem(FOCUS_KEY) === "1";
function applyFocusMode(enabled: boolean) {
  focusMode = enabled;
  document.body.classList.toggle("focus-mode", enabled);
  els.focusMode.setAttribute("aria-pressed", String(enabled));
  els.focusMode.title = enabled ? "Exit focus mode (Ctrl+Shift+F)" : "Focus mode (Ctrl+Shift+F)";
  els.focusExit.hidden = !enabled;
  localStorage.setItem(FOCUS_KEY, enabled ? "1" : "0");
  requestAnimationFrame(() => fitFrame());
}
function toggleFocusMode() { applyFocusMode(!focusMode); }
applyFocusMode(focusMode);
els.focusMode.addEventListener("click", toggleFocusMode);
els.focusExit.addEventListener("click", () => applyFocusMode(false));

function updateFullscreenUi() {
  const active = !!document.fullscreenElement;
  els.fullscreen.setAttribute("aria-pressed", String(active));
  els.fullscreen.title = active ? "Exit fullscreen (F11)" : "Fullscreen (F11)";
}
async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    showToast("Fullscreen is not available in this browser");
  }
}
els.fullscreen.addEventListener("click", () => void toggleFullscreen());
document.addEventListener("fullscreenchange", () => {
  updateFullscreenUi();
  requestAnimationFrame(() => fitFrame());
});
updateFullscreenUi();

window.addEventListener("keydown", (e) => {
  const modifier = e.ctrlKey || e.metaKey;
  if (e.key === "F11") {
    e.preventDefault();
    void toggleFullscreen();
    return;
  }
  if (modifier && e.shiftKey && e.key.toLowerCase() === "f") {
    e.preventDefault();
    toggleFocusMode();
    return;
  }
  if (e.key === "Escape" && focusMode && !document.fullscreenElement) {
    applyFocusMode(false);
  }
});

// ── Suppress Safari's swipe-to-navigate at the tab strip's edges ─────────
// CSS overscroll-behavior on html/body isn't honored by Safari for the
// trackpad page-swipe gesture, so we preventDefault wheel events on the
// tab strip when the user is overscrolling horizontally past either edge.
// Internal horizontal scrolling still works normally.
els.tabs.addEventListener(
  "wheel",
  (e) => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    const atLeft = els.tabs.scrollLeft <= 0;
    const atRight =
      els.tabs.scrollLeft + els.tabs.clientWidth >= els.tabs.scrollWidth - 1;
    if ((atLeft && e.deltaX < 0) || (atRight && e.deltaX > 0)) {
      e.preventDefault();
    }
  },
  { passive: false },
);

// ── Tab orientation (horizontal strip ⇄ vertical sidebar) ────────────────
const ORIENT_KEY = "browserface:orient";
const SIDEBAR_KEY = "browserface:sidebar-width";
const SIDEBAR_MIN = 80;
const SIDEBAR_MAX = 480;
// Below this, dragging snaps the sidebar shut and switches back to the
// horizontal strip. Acts as a "close by drag" affordance — drag the handle
// far enough left and the sidebar hides itself. Stays below MIN so a
// drag-to-min release doesn't immediately close.
const SIDEBAR_CLOSE_AT = 60;
// Width applied when opening the sidebar if the persisted width is too
// narrow to be useful (e.g., last drag landed at the minimum). Keeps
// customized larger widths intact.
const SIDEBAR_OPEN_DEFAULT = 240;
const SIDEBAR_OPEN_FLOOR = 180;

// Narrow-viewport breakpoint. The CSS half lives in style.css under the
// `MOBILE-BP-CSS` marker; media queries can't read CSS variables, so
// changing the value means editing both sides.
const MOBILE_BP = 701;
type Orient = "horizontal" | "vertical";
function applyOrient(o: Orient) {
  document.body.classList.toggle("orient-vertical", o === "vertical");
}
function closeMobileSidebar() {
  document.body.classList.remove("tabs-manager-open");
  const tabManager = document.getElementById("tab-sidebar");
  tabManager?.setAttribute("aria-hidden", "true");
  if (window.innerWidth >= MOBILE_BP) return;
  if (!document.body.classList.contains("orient-vertical")) return;
  applyOrient("horizontal");
  localStorage.setItem(ORIENT_KEY, "horizontal");
}
const storedOrient = localStorage.getItem(ORIENT_KEY);
applyOrient(storedOrient === "vertical" ? "vertical" : "horizontal");

// Tap-outside-to-close for the mobile overlay sidebar. Skipped on desktop
// (where vertical mode is a layout push, not an overlay) and skipped when
// the tap lands inside the sidebar or on the hamburger — the sidebar's
// own button handlers and the toggle button already manage those paths.
document.addEventListener("click", (e) => {
  if (window.innerWidth >= MOBILE_BP) return;
  if (!document.body.classList.contains("orient-vertical")) return;
  const target = e.target as Node;
  if (els.tabSidebar.contains(target)) return;
  if (els.orientToggle.contains(target)) return;
  closeMobileSidebar();
});

// Tap-anywhere-outside-the-frame → send Escape to the remote. Closes any
// open menu / dropdown / modal on the page, since clicking outside the
// frame area (status bar, stage letterbox, toolbar empty space, body
// padding) is the user's natural "dismiss" gesture but those clicks
// otherwise go nowhere — the remote never sees them. Skipped when the
// click lands inside the frame (handled by the touch / mouse path) or
// on an interactive bridge-UI control (buttons, links, inputs, ARIA
// button roles), so a button's own action runs without an extra
// Escape going to the remote.
document.addEventListener("click", (e) => {
  const target = e.target as Element | null;
  if (!target) return;
  if (els.frame.contains(target)) return;
  if (target.closest("button, input, a, [role='button']")) return;
  bridge.send({ type: "key", key: "Escape", code: "Escape", phase: "press" });
});

function applySidebarWidth(px: number) {
  const clamped = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(px)));
  document.documentElement.style.setProperty("--tab-sidebar-width", `${clamped}px`);
  return clamped;
}
const storedWidth = Number(localStorage.getItem(SIDEBAR_KEY));
if (Number.isFinite(storedWidth) && storedWidth > 0) applySidebarWidth(storedWidth);

els.orientToggle.addEventListener("click", () => {
  const next: Orient = document.body.classList.contains("orient-vertical")
    ? "horizontal"
    : "vertical";
  applyOrient(next);
  localStorage.setItem(ORIENT_KEY, next);
  // Bump sub-comfortable widths up to a sane default on open — otherwise
  // a previous drag-to-min release leaves the sidebar reopening tiny.
  if (next === "vertical") {
    const cur = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--tab-sidebar-width"),
    );
    if (!Number.isFinite(cur) || cur < SIDEBAR_OPEN_FLOOR) {
      applySidebarWidth(SIDEBAR_OPEN_DEFAULT);
      localStorage.setItem(SIDEBAR_KEY, String(SIDEBAR_OPEN_DEFAULT));
    }
  }
  fitFrame();
});

// Sidebar resize: drag the handle, update the CSS variable on the fly,
// persist on release. fitFrame after each update so the screencast image
// re-fits the new stage width.
let sidebarDragging = false;
let sidebarStartX = 0;
let sidebarStartW = 0;
els.sidebarResize.addEventListener("mousedown", (e) => {
  e.preventDefault();
  sidebarDragging = true;
  sidebarStartX = e.clientX;
  const cur = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--tab-sidebar-width"),
  );
  sidebarStartW = Number.isFinite(cur) && cur > 0 ? cur : 220;
  els.sidebarResize.classList.add("dragging");
  document.body.classList.add("dragging-sidebar");
});
window.addEventListener("mousemove", (e) => {
  if (!sidebarDragging) return;
  const desired = sidebarStartW + (e.clientX - sidebarStartX);
  if (desired < SIDEBAR_CLOSE_AT) {
    // Drag-to-close: switch to horizontal and end the drag. The width itself
    // stays at its last sane value so re-opening the sidebar feels the same.
    sidebarDragging = false;
    els.sidebarResize.classList.remove("dragging");
    document.body.classList.remove("dragging-sidebar");
    applyOrient("horizontal");
    localStorage.setItem(ORIENT_KEY, "horizontal");
    fitFrame();
    return;
  }
  applySidebarWidth(desired);
  fitFrame();
});
window.addEventListener("mouseup", () => {
  if (!sidebarDragging) return;
  sidebarDragging = false;
  els.sidebarResize.classList.remove("dragging");
  document.body.classList.remove("dragging-sidebar");
  const cur = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--tab-sidebar-width"),
  );
  if (Number.isFinite(cur) && cur > 0) localStorage.setItem(SIDEBAR_KEY, String(Math.round(cur)));
});

// ── Toast (transient error display) ──────────────────────────────────────────

let toastTimer: number | undefined;
function showToast(message: string, durationMs = 4000) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  if (toastTimer !== undefined) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    els.toast.hidden = true;
  }, durationMs);
}

// ── Layout ───────────────────────────────────────────────────────────────────

let keyboardOpen = false;
let lastViewportHeight = window.visualViewport?.height ?? window.innerHeight;

function handleVisualViewport() {
  const vv = window.visualViewport;
  if (!vv) return;

  const currentHeight = vv.height;
  const heightDelta = lastViewportHeight - currentHeight;

  if (window.innerWidth < MOBILE_BP && heightDelta > 120) {
    keyboardOpen = true;
  } else if (window.innerWidth < MOBILE_BP && heightDelta < -80) {
    keyboardOpen = false;
  }

  lastViewportHeight = currentHeight;

  // When the OS keyboard opens, mobile browsers can shrink the visual
  // viewport dramatically. Do not refit the remote browser to that temporary
  // height: doing so makes the cloud browser visibly jump/shrink. Keep the
  // existing frame geometry while the keyboard is open.
  if (!keyboardOpen) requestAnimationFrame(() => fitFrame());
}

window.addEventListener("resize", () => {
  requestAnimationFrame(() => fitFrame());
});

if (window.visualViewport) {
  window.visualViewport.addEventListener("scroll", () => {
    // Some mobile browsers pan the visual viewport without a layout resize.
    // Re-measure so the screencast remains aligned with the visible frame.
    requestAnimationFrame(() => fitFrame());
  });
}

if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", handleVisualViewport);
}

// ── Mouse / scroll ───────────────────────────────────────────────────────────

const mouseTarget = els.frame;

mouseTarget.addEventListener("contextmenu", (e) => e.preventDefault());

mouseTarget.addEventListener("mouseleave", () => {
  // Lets the server start its hovered-link auto-clear timer without waiting
  // for further mousemoves. Without this, a URL hovered just before the
  // cursor exits the frame would linger indefinitely.
  bridge.send({ type: "mouseleave" });
  // Reset the frame's cursor so the bridge UI's own areas (toolbar, etc.)
  // aren't stuck mirroring a remote pointer/text-cursor.
  els.frame.style.cursor = "";
});

// Re-anchor focus once at startup so the first keystroke after page load
// already lands on the paste-helper. Toolbar handles the URL-bar blur path
// via its onUrlBlur callback. Skipped on coarse pointers — focusing the
// hidden helper at load on mobile would mark it as the active element
// before any field exists on the remote, which suppresses the keyboard
// pop later when the selection handler calls focus() on it again.
window.addEventListener("load", () => {
  if (!isCoarsePointer) pasteHelper.focus();
});

// Drag-aware pointer forwarding. We send distinct mousedown / mouseup so the
// remote sees press at one point and release at another — that's what makes
// drag-select work. While the button's held, mousemoves carry the active
// buttons array and skip throttling, since each frame can extend a text
// selection on the page and missing intermediate moves shows up as choppy
// selection edges. Outside a drag, mousemove is throttled (hover-only).
let dragging = false;

function mouseButtonName(button: number): MouseButton {
  if (button === 2) return "right";
  if (button === 1) return "middle";
  return "left";
}

function mouseButtonsFromBits(bits: number): MouseButton[] {
  const buttons: MouseButton[] = [];
  if (bits & 1) buttons.push("left");
  if (bits & 2) buttons.push("right");
  if (bits & 4) buttons.push("middle");
  return buttons;
}

mouseTarget.addEventListener("mousedown", (e) => {
  e.preventDefault();
  refocusPasteHelper();
  if (!isVisible) {
    bridge.send({ type: "refocus" });
    return;
  }
  const { x, y } = pointToViewport(e);
  bridge.send({
    type: "mousedown",
    x,
    y,
    button: mouseButtonName(e.button),
    clickCount: e.detail || 1,
    modifiers: modifiersFromEvent(e),
  });
  dragging = true;
});

// Listen on window so a release outside the frame (user dragged off the edge
// while text-selecting) still finalizes the gesture on the page side.
window.addEventListener("mouseup", (e) => {
  if (!dragging) return;
  dragging = false;
  if (!isVisible) return;
  const { x, y } = pointToViewport(e);
  bridge.send({
    type: "mouseup",
    x,
    y,
    button: mouseButtonName(e.button),
    clickCount: e.detail || 1,
    modifiers: modifiersFromEvent(e),
  });
});

let lastMoveAt = 0;
function dispatchMouseMove(e: MouseEvent) {
  if (!isVisible) return;
  const { x, y } = pointToViewport(e);
  const buttons = mouseButtonsFromBits(e.buttons);
  bridge.send({
    type: "mousemove",
    x,
    y,
    buttons,
    modifiers: modifiersFromEvent(e),
  });
}

mouseTarget.addEventListener("mousemove", (e) => {
  if (dragging) return;
  const now = performance.now();
  if (now - lastMoveAt < 33) return;
  lastMoveAt = now;
  dispatchMouseMove(e);
});

window.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  dispatchMouseMove(e);
});

mouseTarget.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    if (!isVisible) {
      bridge.send({ type: "refocus" });
      return;
    }
    const { x, y } = pointToViewport(e);
    bridge.send({
      type: "scroll",
      x,
      y,
      deltaX: e.deltaX,
      deltaY: e.deltaY,
    });
  },
  { passive: false },
);

// ── Touch (coarse pointer) ───────────────────────────────────────────────────
//
// Set up regardless of pointer kind so a desktop with a touchscreen still
// works; nothing here fires unless the user actually touches.
setupTouch({
  frame: els.frame,
  send: bridge.send,
  pointToViewport,
  getRemoteToLocalScale: () => {
    const local = els.frame.clientWidth;
    return local > 0 ? viewport.width / local : 1;
  },
  onProbeStart: () => {
    probeInFlight = true;
  },
  focusPasteHelperOnTap: () => {
    // Force-focus the helper inside the touch gesture if we have any
    // signal that the tap might land on an editable target:
    //   - lastCursorEditable: the touchstart probe completed and said
    //     yes (deterministic).
    //   - remoteHasField: the remote was already on a field before the
    //     tap (covers tapping the same input twice).
    //   - probeInFlight: the touchstart probe hasn't returned yet, so
    //     we don't know — speculate. Selection handler dismisses the
    //     keyboard ~100ms later if the click turned out non-editable.
    // Everything else: don't focus, so plain text / image taps don't
    // flash the keyboard. Uses forceFocus (blur + focus) so iOS sees
    // a fresh focus transition even when the helper was already
    // focused from a prior selection-handler call.
    if (lastCursorEditable || remoteHasField || probeInFlight) {
      pasteHelper.forceFocus();
    }
  },
});

// ── Viewport size buttons ────────────────────────────────────────────────────
//
// Two one-tap shortcuts that ship `setViewport`:
//
//   - Match size (always visible — replaces the old drag handle): resizes
//     the remote so it fills what the user can actually see. On desktop
//     that's the frame area (stage − in-stage status bar) so there's no
//     letterboxing around the screencast; on mobile that's the window
//     itself, because `body { height: 100% }` measures iOS Safari's
//     layout viewport (which includes the URL-bar zone), and using it
//     would leave the remote rendered taller than the visible viewport.
//
//   - Desktop size (narrow screens only): remote = (1280, 1280 × phone-
//     aspect). Wide enough that responsive sites pick the desktop layout,
//     kept at the visible viewport's aspect so the screencast fills the
//     screen without big letterboxing. Trade-off on a phone: tall content
//     area, more scrolling than a real desktop window.
const DESKTOP_PRESET_WIDTH = 1280;
function matchSizeArea(): { w: number; h: number } {
  // Below the narrow breakpoint, prefer the visual viewport (or innerWidth/
  // innerHeight). Mobile-designed pages expect to render at the phone's
  // actual screen dims; using the smaller frame area would silently shrink
  // them and the visual viewport handles iOS URL-bar collapse for free.
  if (window.innerWidth < MOBILE_BP) {
    const vv = window.visualViewport;
    return {
      w: Math.max(1, Math.round(vv?.width ?? window.innerWidth)),
      h: Math.max(1, Math.round(vv?.height ?? window.innerHeight)),
    };
  }
  // Desktop: subtract the in-stage status bar so the screencast fills the
  // frame box at 1:1. Tab strip + toolbar live outside the stage already.
  const statusbar = document.querySelector(".statusbar") as HTMLElement | null;
  const statusH = statusbar ? statusbar.offsetHeight : 0;
  return {
    w: Math.max(1, els.stage.clientWidth),
    h: Math.max(1, els.stage.clientHeight - statusH),
  };
}
els.vpMatchSize.addEventListener("click", () => {
  const { w, h } = matchSizeArea();
  bridge.send({ type: "setViewport", width: w, height: h });
});
els.vpDesktopSize.addEventListener("click", () => {
  // Desktop-size is only visible at narrow widths, so the aspect always
  // comes from the phone's visible viewport — pinning to matchSizeArea
  // means the desktop-width window stays at the same shape as the
  // user's screen, no letterboxing when the frame fits to it.
  const { w, h } = matchSizeArea();
  bridge.send({
    type: "setViewport",
    width: DESKTOP_PRESET_WIDTH,
    height: Math.round((DESKTOP_PRESET_WIDTH * h) / w),
  });
});



// Server-side download manager. Files stay on the dedicated server volume;
// "Download to phone" is an explicit, user-triggered transfer.
const downloadsButton = document.getElementById("downloads") as HTMLButtonElement | null;
const downloadsPanel = document.getElementById("downloads-panel") as HTMLElement | null;
const downloadsClose = document.getElementById("downloads-close") as HTMLButtonElement | null;
const downloadsList = document.getElementById("downloads-list") as HTMLElement | null;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

async function refreshDownloads() {
  if (!downloadsList) return;
  try {
    const r = await fetch("./downloads", { cache: "no-store" });
    if (!r.ok) throw new Error("download list unavailable");
    const data = await r.json() as { files?: Array<{name:string;size:number;mtime:number}> };
    const files = data.files ?? [];
    if (!files.length) {
      downloadsList.innerHTML = '<div class="downloads-empty">No downloads yet.</div>';
      return;
    }
    downloadsList.replaceChildren(...files.map((file) => {
      const row = document.createElement("div");
      row.className = "download-row";
      const info = document.createElement("div");
      info.className = "download-info";
      const name = document.createElement("div");
      name.className = "download-name";
      name.textContent = file.name;
      const meta = document.createElement("div");
      meta.className = "download-meta";
      meta.textContent = formatBytes(file.size);
      info.append(name, meta);
      const actions = document.createElement("div");
      actions.className = "download-actions";
      const phone = document.createElement("a");
      phone.className = "download-phone";
      phone.textContent = "To phone";
      phone.href = `./downloads/file?name=${encodeURIComponent(file.name)}`;
      phone.download = file.name;
      const del = document.createElement("button");
      del.type = "button";
      del.textContent = "Delete";
      del.addEventListener("click", async () => {
        del.disabled = true;
        try {
          await fetch(`./downloads/file?name=${encodeURIComponent(file.name)}`, { method: "DELETE" });
          await refreshDownloads();
        } catch { del.disabled = false; }
      });
      actions.append(phone, del);
      row.append(info, actions);
      return row;
    }));
  } catch {
    downloadsList.innerHTML = '<div class="downloads-empty">Downloads unavailable.</div>';
  }
}

downloadsButton?.addEventListener("click", () => {
  if (!downloadsPanel) return;
  downloadsPanel.hidden = !downloadsPanel.hidden;
  if (!downloadsPanel.hidden) void refreshDownloads();
});
downloadsClose?.addEventListener("click", () => { if (downloadsPanel) downloadsPanel.hidden = true; });
window.setInterval(() => { if (downloadsPanel && !downloadsPanel.hidden) void refreshDownloads(); }, 3000);

// Server-side file manager. Everything here lives outside the project tree.
const filesButton = document.getElementById("files") as HTMLButtonElement | null;
const filesPanel = document.getElementById("files-panel") as HTMLElement | null;
const filesClose = document.getElementById("files-close") as HTMLButtonElement | null;
const filesList = document.getElementById("files-list") as HTMLElement | null;
const filesBreadcrumb = document.getElementById("files-breadcrumb") as HTMLElement | null;
const filesUp = document.getElementById("files-up") as HTMLButtonElement | null;
const filesRefresh = document.getElementById("files-refresh") as HTMLButtonElement | null;
const filesNewFolder = document.getElementById("files-new-folder") as HTMLButtonElement | null;
const filesUpload = document.getElementById("files-upload") as HTMLButtonElement | null;
const filesUploadInput = document.getElementById("files-upload-input") as HTMLInputElement | null;
let filesPath = "";

function formatFileDate(ms: number): string {
  return new Date(ms).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}

function fileUrl(path: string): string {
  return "./files/download?path=" + encodeURIComponent(path);
}

function renderFilesBreadcrumb() {
  if (!filesBreadcrumb) return;
  const parts = filesPath ? filesPath.split("/") : [];
  filesBreadcrumb.replaceChildren();
  const root = document.createElement("button");
  root.type = "button";
  root.textContent = "Browserface";
  root.onclick = () => { filesPath = ""; void refreshFiles(); };
  filesBreadcrumb.append(root);
  let acc = "";
  parts.forEach((part) => {
    const sep = document.createElement("span");
    sep.textContent = "/";
    filesBreadcrumb.append(sep);
    acc = acc ? acc + "/" + part : part;
    const p = acc;
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = part;
    b.onclick = () => { filesPath = p; void refreshFiles(); };
    filesBreadcrumb.append(b);
  });
}

async function refreshFiles() {
  if (!filesList) return;
  renderFilesBreadcrumb();
  filesList.innerHTML = "<div class=\"downloads-empty\">Loading…</div>";
  try {
    const r = await fetch("./files?path=" + encodeURIComponent(filesPath), { cache: "no-store" });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json() as { entries?: Array<{name:string;path:string;kind:"file"|"directory";size:number;mtime:number}> };
    const entries = data.entries ?? [];
    if (!entries.length) {
      filesList.innerHTML = "<div class=\"downloads-empty\">Empty folder.</div>";
      return;
    }
    filesList.replaceChildren(...entries.map((entry) => {
      const row = document.createElement("div");
      row.className = "file-row";
      const main = document.createElement("div");
      main.className = "file-main";
      const icon = document.createElement("span");
      icon.className = "file-icon";
      icon.textContent = entry.kind === "directory" ? "📁" : "📄";
      const info = document.createElement("div");
      const name = document.createElement("div");
      name.className = "file-name";
      name.textContent = entry.name;
      const meta = document.createElement("div");
      meta.className = "file-meta";
      meta.textContent = entry.kind === "directory" ? "Folder" : formatBytes(entry.size) + " · " + formatFileDate(entry.mtime);
      info.append(name, meta);
      main.append(icon, info);
      main.onclick = () => { if (entry.kind === "directory") { filesPath = entry.path; void refreshFiles(); } };
      const actions = document.createElement("div");
      actions.className = "file-actions";
      if (entry.kind === "file") {
        const phone = document.createElement("a");
        phone.textContent = "To phone";
        phone.href = fileUrl(entry.path);
        phone.download = entry.name;
        actions.append(phone);
      }
      const rename = document.createElement("button");
      rename.type = "button";
      rename.textContent = "Rename";
      rename.onclick = async () => {
        const next = window.prompt("New name", entry.name);
        if (!next || next === entry.name) return;
        rename.disabled = true;
        try {
          const r = await fetch("./files/rename", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: entry.path, name: next }) });
          if (!r.ok) throw new Error(await r.text());
          await refreshFiles();
        } catch (err) { window.alert(err instanceof Error ? err.message : "Rename failed"); rename.disabled = false; }
      };
      const del = document.createElement("button");
      del.type = "button";
      del.textContent = "Delete";
      del.onclick = async () => {
        if (!window.confirm("Delete " + entry.name + "?")) return;
        del.disabled = true;
        try {
          const r = await fetch("./files?path=" + encodeURIComponent(entry.path), { method: "DELETE" });
          if (!r.ok) throw new Error(await r.text());
          await refreshFiles();
        } catch (err) { window.alert(err instanceof Error ? err.message : "Delete failed"); del.disabled = false; }
      };
      actions.append(rename, del);
      row.append(main, actions);
      return row;
    }));
  } catch (err) {
    filesList.innerHTML = "<div class=\"downloads-empty\">Files unavailable: " + (err instanceof Error ? err.message : "error") + "</div>";
  }
}

filesButton?.addEventListener("click", () => {
  if (!filesPanel) return;
  filesPanel.hidden = !filesPanel.hidden;
  if (!filesPanel.hidden) void refreshFiles();
});
filesClose?.addEventListener("click", () => { if (filesPanel) filesPanel.hidden = true; });
filesRefresh?.addEventListener("click", () => void refreshFiles());
filesUp?.addEventListener("click", () => {
  if (!filesPath) return;
  filesPath = filesPath.split("/").slice(0, -1).join("/");
  void refreshFiles();
});
filesNewFolder?.addEventListener("click", async () => {
  const name = window.prompt("Folder name");
  if (!name) return;
  try {
    const r = await fetch("./files/mkdir?path=" + encodeURIComponent(filesPath) + "&name=" + encodeURIComponent(name), { method: "POST" });
    if (!r.ok) throw new Error(await r.text());
    await refreshFiles();
  } catch (err) { window.alert(err instanceof Error ? err.message : "Folder creation failed"); }
});
filesUpload?.addEventListener("click", () => filesUploadInput?.click());
filesUploadInput?.addEventListener("change", async () => {
  const selected = Array.from(filesUploadInput.files ?? []);
  for (const file of selected) {
    try {
      const r = await fetch("./files/upload?path=" + encodeURIComponent(filesPath) + "&name=" + encodeURIComponent(file.name), { method: "POST", body: file });
      if (!r.ok) throw new Error(await r.text());
    } catch (err) { window.alert(file.name + ": " + (err instanceof Error ? err.message : "upload failed")); }
  }
  filesUploadInput.value = "";
  await refreshFiles();
});

const workspacesButton = document.getElementById("workspaces") as HTMLButtonElement | null;
const workspacesPanel = document.getElementById("workspaces-panel") as HTMLElement | null;
const workspacesClose = document.getElementById("workspaces-close") as HTMLButtonElement | null;
const workspacesList = document.getElementById("workspaces-list") as HTMLElement | null;
const workspaceNew = document.getElementById("workspace-new") as HTMLButtonElement | null;
const workspaceRefresh = document.getElementById("workspace-refresh") as HTMLButtonElement | null;

async function refreshWorkspaces() {
  if (!workspacesList) return;
  workspacesList.innerHTML = '<div class="downloads-empty">Loading…</div>';
  try {
    const r = await fetch("./workspaces", { cache: "no-store" });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json() as { active: string; workspaces: Array<{id:string;name:string;port:number;builtIn?:boolean}> };
    if (!data.workspaces.length) {
      workspacesList.innerHTML = '<div class="downloads-empty">No workspaces.</div>';
      return;
    }
    workspacesList.replaceChildren(...data.workspaces.map((workspace) => {
      const row = document.createElement("div");
      row.className = "file-row";
      const main = document.createElement("div");
      main.className = "file-main";
      const icon = document.createElement("span");
      icon.className = "file-icon";
      icon.textContent = workspace.id === data.active ? "●" : "○";
      const info = document.createElement("div");
      const name = document.createElement("div");
      name.className = "file-name";
      name.textContent = workspace.name + (workspace.id === data.active ? " · Active" : "");
      const meta = document.createElement("div");
      meta.className = "file-meta";
      meta.textContent = workspace.builtIn ? "Main persistent profile" : "Isolated persistent profile";
      info.append(name, meta);
      main.append(icon, info);
      const actions = document.createElement("div");
      actions.className = "file-actions";
      if (workspace.id !== data.active) {
        const activate = document.createElement("button");
        activate.type = "button";
        activate.textContent = "Open";
        activate.onclick = async () => {
          activate.disabled = true;
          try {
            const r = await fetch("./workspaces/activate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: workspace.id }) });
            if (!r.ok) throw new Error(await r.text());
            await refreshWorkspaces();
          } catch (err) { window.alert(err instanceof Error ? err.message : "Workspace switch failed"); activate.disabled = false; }
        };
        actions.append(activate);
      }
      if (!workspace.builtIn && workspace.id !== data.active) {
        const del = document.createElement("button");
        del.type = "button";
        del.textContent = "Delete";
        del.onclick = async () => {
          if (!window.confirm("Delete workspace " + workspace.name + "?")) return;
          const r = await fetch("./workspaces?id=" + encodeURIComponent(workspace.id), { method: "DELETE" });
          if (r.ok) await refreshWorkspaces();
          else window.alert(await r.text());
        };
        actions.append(del);
      }
      row.append(main, actions);
      return row;
    }));
  } catch (err) {
    workspacesList.innerHTML = "<div class=\"downloads-empty\">Workspaces unavailable: " + (err instanceof Error ? err.message : "error") + "</div>";
  }
}

workspacesButton?.addEventListener("click", () => {
  if (!workspacesPanel) return;
  workspacesPanel.hidden = !workspacesPanel.hidden;
  if (!workspacesPanel.hidden) void refreshWorkspaces();
});
workspacesClose?.addEventListener("click", () => { if (workspacesPanel) workspacesPanel.hidden = true; });
workspaceRefresh?.addEventListener("click", () => void refreshWorkspaces());
workspaceNew?.addEventListener("click", async () => {
  const name = window.prompt("Workspace name");
  if (!name) return;
  workspaceNew.disabled = true;
  try {
    const r = await fetch("./workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
    if (!r.ok) throw new Error(await r.text());
    await refreshWorkspaces();
  } catch (err) { window.alert(err instanceof Error ? err.message : "Workspace creation failed"); }
  finally { workspaceNew.disabled = false; }
});

const reopenTabButton = document.getElementById("reopen-tab") as HTMLButtonElement | null;
reopenTabButton?.addEventListener("click", async () => {
  reopenTabButton.disabled = true;
  try {
    const r = await fetch("./session/reopen", { method: "POST" });
    if (!r.ok && r.status !== 404) throw new Error(await r.text());
    if (r.status === 404) showToast("No recently closed tab");
  } catch (err) { showToast(err instanceof Error ? err.message : "Could not reopen tab"); }
  finally { reopenTabButton.disabled = false; }
});

const libraryButton = document.getElementById("library") as HTMLButtonElement | null;
const libraryPanel = document.getElementById("library-panel") as HTMLElement | null;
const libraryClose = document.getElementById("library-close") as HTMLButtonElement | null;
const libraryList = document.getElementById("library-list") as HTMLElement | null;
const bookmarkCurrent = document.getElementById("bookmark-current") as HTMLButtonElement | null;
const sessionSave = document.getElementById("session-save") as HTMLButtonElement | null;
const sessionRestore = document.getElementById("session-restore") as HTMLButtonElement | null;
const sessionReplace = document.getElementById("session-replace") as HTMLButtonElement | null;
const groupSave = document.getElementById("group-save") as HTMLButtonElement | null;

async function refreshLibrary() {
  if (!libraryList) return;
  try {
    const r = await fetch("./library", { cache: "no-store" });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json() as { bookmarks: Array<{id:string;title:string;url:string}>; history: Array<{title:string;url:string;visitedAt:number}>; sessionTabs: Array<{title:string;url:string}>; groups: Array<{id:string;name:string;tabs:Array<{title:string;url:string}>}> };
    libraryList.replaceChildren();
    const section = (label: string) => { const h = document.createElement("div"); h.className = "file-meta"; h.textContent = label; h.style.padding = "10px 4px 4px"; libraryList.append(h); };
    const row = (title: string, url: string, action: () => void, extra?: () => void) => {
      const el = document.createElement("div"); el.className = "file-row";
      const main = document.createElement("div"); main.className = "file-main";
      const info = document.createElement("div");
      const name = document.createElement("div"); name.className = "file-name"; name.textContent = title || url;
      const meta = document.createElement("div"); meta.className = "file-meta"; meta.textContent = url;
      info.append(name, meta); main.append(info); main.addEventListener("click", action);
      const actions = document.createElement("div"); actions.className = "file-actions";
      const open = document.createElement("button"); open.type = "button"; open.textContent = "Open"; open.onclick = action; actions.append(open);
      if (extra) { const x = document.createElement("button"); x.type = "button"; x.textContent = "×"; x.onclick = extra; actions.append(x); }
      el.append(main, actions); libraryList.append(el);
    };
    if (data.bookmarks.length) {
      section("BOOKMARKS");
      for (const b of data.bookmarks.slice(0, 50)) row(b.title, b.url, () => bridge.send({ type: "navigate", url: b.url }), async () => { await fetch("./bookmarks?url=" + encodeURIComponent(b.url), { method: "DELETE" }); await refreshLibrary(); });
    }
    if (data.groups.length) {
      section("TAB GROUPS");
      for (const g of data.groups) row(g.name, `${g.tabs.length} saved tabs`, async () => { const r = await fetch("./groups/open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: g.id }) }); if (!r.ok) window.alert(await r.text()); }, async () => { await fetch("./groups?id=" + encodeURIComponent(g.id), { method: "DELETE" }); await refreshLibrary(); });
    }
    if (data.sessionTabs.length) {
      section("SAVED SESSION");
      const info = document.createElement("div"); info.className = "downloads-empty"; info.textContent = `${data.sessionTabs.length} tabs saved in this workspace`; libraryList.append(info);
    }
    if (data.history.length) {
      section("RECENT HISTORY");
      for (const h of data.history.slice(0, 50)) row(h.title, h.url, () => bridge.send({ type: "navigate", url: h.url }));
    }
    if (!libraryList.childElementCount) libraryList.innerHTML = '<div class="downloads-empty">Nothing saved yet.</div>';
  } catch (err) { libraryList.innerHTML = '<div class="downloads-empty">Library unavailable: ' + (err instanceof Error ? err.message : "error") + '</div>'; }
}

libraryButton?.addEventListener("click", () => { if (!libraryPanel) return; libraryPanel.hidden = !libraryPanel.hidden; if (!libraryPanel.hidden) void refreshLibrary(); });
libraryClose?.addEventListener("click", () => { if (libraryPanel) libraryPanel.hidden = true; });
bookmarkCurrent?.addEventListener("click", async () => {
  const url = els.url.value.trim(); if (!/^https?:\/\//i.test(url)) { window.alert("Open a web page first."); return; }
  const r = await fetch("./bookmarks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url, title: document.title.replace(/ — browserface$/, "") }) });
  if (!r.ok) window.alert(await r.text()); else await refreshLibrary();
});
async function sessionAction(path: string) { const r = await fetch(path, { method: "POST" }); if (!r.ok) window.alert(await r.text()); else await refreshLibrary(); }
sessionSave?.addEventListener("click", () => void sessionAction("./session/save"));
sessionRestore?.addEventListener("click", () => void sessionAction("./session/restore"));
sessionReplace?.addEventListener("click", () => void sessionAction("./session/restore?replace=1"));
groupSave?.addEventListener("click", async () => { const name = window.prompt("Tab group name"); if (!name) return; const r = await fetch("./groups", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }); if (!r.ok) window.alert(await r.text()); else await refreshLibrary(); });


// ── Mobile-first navigation + unified menu ─────────────────────────────────
const browserMenu = document.getElementById("browser-menu") as HTMLButtonElement | null;
const mobileMenu = document.getElementById("mobile-menu") as HTMLButtonElement | null;
const browserMenuPanel = document.getElementById("browser-menu-panel") as HTMLElement | null;
const menuScrim = document.getElementById("menu-scrim") as HTMLElement | null;
const browserMenuClose = document.getElementById("browser-menu-close") as HTMLButtonElement | null;
const mobileTabs = document.getElementById("mobile-tabs") as HTMLButtonElement | null;
const mobileNewTab = document.getElementById("mobile-new-tab") as HTMLButtonElement | null;
const mobileHome = document.getElementById("mobile-home") as HTMLButtonElement | null;
const menuStatus = document.getElementById("menu-status") as HTMLElement | null;
const menuFps = document.getElementById("menu-fps") as HTMLElement | null;
const menuViewport = document.getElementById("menu-viewport") as HTMLElement | null;
const menuPageTitle = document.getElementById("menu-page-title") as HTMLElement | null;

function setBrowserMenu(open: boolean) {
  if (!browserMenuPanel) return;
  browserMenuPanel.hidden = !open;
  if (menuScrim) menuScrim.hidden = !open;
  browserMenu?.setAttribute("aria-expanded", String(open));
  if (open) {
    menuPageTitle && (menuPageTitle.textContent = document.title.replace(/ — browserface$/, "") || "Browser");
    updateMenuStats();
  }
}
function updateMenuStats() {
  if (menuStatus) menuStatus.textContent = els.status.textContent || "—";
  if (menuFps) menuFps.textContent = els.fps.textContent || "—";
  if (menuViewport) menuViewport.textContent = `${viewport.width} × ${viewport.height}`;
}
function runMenuAction(action: string) {
  setBrowserMenu(false);
  if (action === "downloads") document.getElementById("downloads")?.click();
  else if (action === "files") document.getElementById("files")?.click();
  else if (action === "workspaces") document.getElementById("workspaces")?.click();
  else if (action === "library") document.getElementById("library")?.click();
  else if (action === "reopen") document.getElementById("reopen-tab")?.click();
  else if (action === "focus") toggleFocusMode();
  else if (action === "fullscreen") void toggleFullscreen();
  else if (action === "external") document.getElementById("open-external")?.click();
  else if (action === "find") {
    // Use the existing keyboard path so the current find implementation remains authoritative.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
  }
}
browserMenu?.addEventListener("click", () => setBrowserMenu(browserMenuPanel?.hidden !== false));
mobileMenu?.addEventListener("click", () => setBrowserMenu(browserMenuPanel?.hidden !== false));
browserMenuClose?.addEventListener("click", () => setBrowserMenu(false));
menuScrim?.addEventListener("click", () => setBrowserMenu(false));
browserMenuPanel?.querySelectorAll<HTMLButtonElement>("[data-menu-action]").forEach((button) => {
  button.addEventListener("click", () => runMenuAction(button.dataset.menuAction || ""));
});

mobileTabs?.addEventListener("click", () => {
  setBrowserMenu(false);
  document.body.classList.add("tabs-manager-open");
  els.tabSidebar.setAttribute("aria-hidden", "false");
});
mobileNewTab?.addEventListener("click", () => {
  setBrowserMenu(false);
  bridge.send({ type: "newTab" });
  toolbar.focusUrl();
});
mobileHome?.addEventListener("click", () => {
  setBrowserMenu(false);
  bridge.send({ type: "newTab", url: "chrome://newtab/" });
  toolbar.focusUrl();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (browserMenuPanel && !browserMenuPanel.hidden) setBrowserMenu(false);
    if (document.body.classList.contains("tabs-manager-open")) closeMobileSidebar();
  }
});

// Keep the compact performance readout current without introducing a second status system.
setInterval(updateMenuStats, 1000);

[executed on device: ip-172-31-44-71 (13ee5edb-ae63-40e5-b176-f056db72d14f)]