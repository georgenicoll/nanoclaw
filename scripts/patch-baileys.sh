#!/bin/sh
# Patch Baileys to fix LID participant encoding in group messages.
# extractDeviceJids discards the server field from JIDs, causing LID accounts
# (@lid) to be re-encoded as @s.whatsapp.net, which the WA server ignores,
# causing assertSessions to hang indefinitely.

SIGNAL="node_modules/@whiskeysockets/baileys/lib/Utils/signal.js"
SEND="node_modules/@whiskeysockets/baileys/lib/Socket/messages-send.js"

# Patch signal.js: preserve server field in extractDeviceJids
if grep -q "extracted.push({ user, device });" "$SIGNAL" 2>/dev/null; then
  sed -i \
    's/const { user } = (0, WABinary_1.jidDecode)(id);/const { user, server: userServer } = (0, WABinary_1.jidDecode)(id);/' \
    "$SIGNAL"
  sed -i \
    's/extracted\.push({ user, device });/extracted.push({ user, device, server: userServer });/' \
    "$SIGNAL"
  echo "Patched $SIGNAL"
else
  echo "$SIGNAL already patched or not found"
fi

# Patch messages-send.js: use preserved server when encoding device JIDs
if grep -q "d\.user, isLid ? 'lid' : 's\.whatsapp\.net', d\.device" "$SEND" 2>/dev/null; then
  sed -i \
    "s/d\.user, isLid ? 'lid' : 's\.whatsapp\.net', d\.device/d.user, d.server || (isLid ? 'lid' : 's.whatsapp.net'), d.device/g" \
    "$SEND"
  echo "Patched $SEND (patchMessageBeforeSending line)"
else
  echo "$SEND patchMessageBeforeSending line already patched or not found"
fi

if grep -q "const { user, device } of devices" "$SEND" 2>/dev/null; then
  sed -i \
    "s/const { user, device } of devices/const { user, device, server: deviceServer } of devices/" \
    "$SEND"
  sed -i \
    "s/(user, isLid ? 'lid' : 's\.whatsapp\.net', device)/(user, deviceServer || (isLid ? 'lid' : 's.whatsapp.net'), device)/" \
    "$SEND"
  echo "Patched $SEND (sender key loop)"
else
  echo "$SEND sender key loop already patched or not found"
fi
