#!/usr/bin/env bash
set -u

ROOT="/opt/browserface"
cd "$ROOT"

echo "============================================================"
echo " BROWSERFACE DEEP AUDIT"
echo " $(date)"
echo "============================================================"

echo
echo "========== PROJECT =========="
printf 'VERSION: '; node -p "require('./package.json').version"
printf 'COMMIT: '; git rev-parse --short HEAD 2>/dev/null || echo unknown
printf 'NODE: '; node -v
printf 'NPM: '; npm -v

echo
echo "========== SOURCE FILES =========="
find src -type f -maxdepth 3 -print | sort

echo
echo "========== TOUCH / POINTER =========="
grep -RniE \
'pointerdown|pointerup|pointermove|pointercancel|touchstart|touchmove|touchend|touchcancel|mousedown|mouseup|mousemove|click|contextmenu|drag|passive|preventDefault|stopPropagation|setPointerCapture|releasePointerCapture' \
src/client --exclude='*.map' 2>/dev/null || true

echo
echo "========== SCROLL =========="
grep -RniE \
'scroll|scrollTo|scrollBy|scrollIntoView|overflow|overscroll|touch-action' \
src/client --exclude='*.map' 2>/dev/null || true

echo
echo "========== KEYBOARD / FOCUS =========="
grep -RniE \
'visualViewport|keyboard|focus|blur|activeElement|selection|caret|textarea|input|contenteditable|paste|clipboard' \
src/client --exclude='*.map' 2>/dev/null || true

echo
echo "========== VIEWPORT / RESIZE =========="
grep -RniE \
'fitFrame|setViewport|viewport|ResizeObserver|window\.resize|innerWidth|innerHeight|deviceScaleFactor' \
src/client src/server --exclude='*.map' 2>/dev/null || true

echo
echo "========== WEBSOCKET =========="
grep -RniE \
'WebSocket|bufferedAmount|binaryType|ArrayBuffer|BFR1|send\(|onmessage|onclose|onopen|reconnect' \
src/client src/server --exclude='*.map' 2>/dev/null || true

echo
echo "========== SCREENSHOT / STREAM =========="
grep -RniE \
'screencast|Screenshot|screenshot|quality|maxFps|max-fps|frame|backpressure|drop|requestAnimationFrame' \
src/client src/server --exclude='*.map' 2>/dev/null || true

echo
echo "========== CHROME / CDP =========="
grep -RniE \
'chrome-remote-interface|Browser\.|Page\.|Input\.|Runtime\.|Emulation\.|setWindowBounds|dispatchMouseEvent|dispatchTouchEvent|screencastFrame' \
src/server --exclude='*.map' 2>/dev/null || true

echo
echo "========== EVENT LISTENERS =========="
grep -RniE \
'addEventListener|removeEventListener' \
src/client --exclude='*.map' 2>/dev/null || true

echo
echo "========== RAF / TIMERS =========="
grep -RniE \
'requestAnimationFrame|cancelAnimationFrame|setTimeout|setInterval|clearTimeout|clearInterval' \
src/client src/server --exclude='*.map' 2>/dev/null || true

echo
echo "========== CSS INTERACTION =========="
grep -RniE \
'user-select|touch-action|pointer-events|overscroll|overflow|cursor|transition|animation' \
src/client --include='*.css' 2>/dev/null || true

echo
echo "========== PROTOCOL =========="
sed -n '1,260p' src/shared/protocol.ts 2>/dev/null || true

echo
echo "========== CLIENT BRIDGE =========="
sed -n '1,240p' src/client/bridge.ts 2>/dev/null || true

echo
echo "========== MAIN CLIENT =========="
sed -n '1,760p' src/client/main.ts 2>/dev/null || true

echo
echo "========== CLIENT CSS =========="
sed -n '1,1200p' src/client/style.css 2>/dev/null || true

echo
echo "========== SERVER BRIDGE =========="
sed -n '1,300p' src/server/bridge.ts 2>/dev/null || true

echo
echo "========== CDP SESSION TOUCH/INPUT/STREAM =========="
grep -n -B20 -A45 -E \
'dispatchMouseEvent|dispatchTouchEvent|screencastFrame|startScreencast|setViewport|setWindowBounds|Input\.' \
src/server/cdp-session.ts 2>/dev/null || true

echo
echo "========== SERVICE =========="
systemctl cat browserface 2>/dev/null || true

echo
echo "========== RUNTIME =========="
systemctl is-active browserface 2>/dev/null || true
ss -ltnp 2>/dev/null | grep ':3000' || true

echo
echo "========== EFFECTIVE STREAM FLAGS =========="
systemctl show browserface -p ExecStart --no-pager 2>/dev/null |
grep -oE -- '--max-fps [0-9]+|--quality [0-9]+' || true

echo
echo "========== RECENT SERVICE ERRORS =========="
sudo journalctl -u browserface --since '-30 min' -p warning..alert -o cat --no-pager 2>/dev/null || true

echo
echo "========== TYPECHECK =========="
npm run typecheck

echo
echo "============================================================"
echo " AUDIT COMPLETE"
echo "============================================================"
