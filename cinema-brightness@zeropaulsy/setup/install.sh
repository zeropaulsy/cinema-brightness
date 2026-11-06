#!/bin/bash
# SPDX-License-Identifier: GPL-2.0-or-later
# One-time system setup for Cinema Display Brightness. Run as root
# (the extension runs it through pkexec from its menu).
#
#  1. udev rule: gives the logged-in user access to the displays' hiddev
#     nodes (TAG+="uaccess", no world-writable devices, no sudo).
#  2. For models the kernel normally hands to the `appledisplay` driver
#     (and tells usbhid to ignore), force usbhid to take them instead:
#     usbhid quirk NO_IGNORE|HIDDEV_FORCE and blacklist appledisplay.
#  3. Apply what can be applied live; a reboot is needed for the quirk.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo "This script must be run as root (e.g. sudo $0)." >&2
    exit 1
fi

UDEV_RULE=/etc/udev/rules.d/70-cinema-brightness.rules
MODPROBE_CONF=/etc/modprobe.d/zz-cinema-brightness.conf

# All models acdcontrol-style brightness control works on.
SUPPORTED="9215 9217 9218 9219 921b 921c 921d 921e 9221 9222 9226 9227 9232 9236"
# Models in the kernel's usbhid ignore list (claimed by appledisplay).
IGNORED="9218 9219 921c 921d 9222 9226 9236"
QUIRK=0x40000010   # HID_QUIRK_NO_IGNORE | HID_QUIRK_HIDDEV_FORCE
MAX_QUIRKS=4       # usbhid only accepts 4 quirk entries

# --- 1. udev rule -----------------------------------------------------------
{
    echo "# Installed by the Cinema Display Brightness GNOME extension."
    for p in $SUPPORTED; do
        echo "KERNEL==\"hiddev*\", SUBSYSTEM==\"usbmisc\", ATTRS{idVendor}==\"05ac\", ATTRS{idProduct}==\"$p\", TAG+=\"uaccess\""
    done
} > "$UDEV_RULE"
echo "Wrote $UDEV_RULE"

# --- 2. usbhid quirks + blacklist -------------------------------------------
# Prefer the ignored models actually connected; otherwise fall back to the
# first few from the list. Keep any usbhid quirks other files already set,
# since only one `quirks=` value wins.
connected=()
for d in /sys/bus/usb/devices/*; do
    [ "$(cat "$d/idVendor" 2>/dev/null)" = 05ac ] || continue
    p=$(cat "$d/idProduct" 2>/dev/null)
    case " $IGNORED " in *" $p "*) connected+=("$p") ;; esac
done

declare -A seen=()
entries=()
add_entry() {
    local key="${1,,}"
    [ -n "${seen[$key]:-}" ] && return
    [ "${#entries[@]}" -ge "$MAX_QUIRKS" ] && return
    seen[$key]=1
    entries+=("$1")
}

for p in "${connected[@]}"; do add_entry "0x05ac:0x$p:$QUIRK"; done

existing=""
for f in /etc/modprobe.d/*.conf; do
    [ "$f" = "$MODPROBE_CONF" ] && continue
    existing+=$(grep -sE '^\s*options\s+usbhid\s+.*quirks=' "$f" \
                | sed -E 's/.*quirks=([^ ]*).*/\1/' | tr ',' '\n' || true)
    existing+=$'\n'
done
for e in $existing; do
    # Our own models get our quirk value; other devices keep theirs.
    vp=$(echo "$e" | cut -d: -f1-2 | tr 'A-F' 'a-f')
    case " ${!seen[*]} " in *"$vp:"*) continue ;; esac
    add_entry "$e"
done

if [ "${#connected[@]}" -eq 0 ]; then
    for p in $IGNORED; do add_entry "0x05ac:0x$p:$QUIRK"; done
fi

{
    echo "# Installed by the Cinema Display Brightness GNOME extension."
    echo "# Let usbhid (hiddev) drive Apple displays instead of appledisplay."
    if [ "${#entries[@]}" -gt 0 ]; then
        echo "options usbhid quirks=$(IFS=,; echo "${entries[*]}")"
    fi
    echo "blacklist appledisplay"
} > "$MODPROBE_CONF"
echo "Wrote $MODPROBE_CONF"

# Other files setting usbhid quirks would fight over the value.
others=$(grep -lsE '^\s*options\s+usbhid\s+.*quirks=' /etc/modprobe.d/*.conf | grep -v -F "$MODPROBE_CONF" || true)
if [ -n "$others" ]; then
    echo "Note: these files also set usbhid quirks (their entries were merged in);"
    echo "you can remove them: $others"
fi

# The quirk must also be in the initramfs if usbhid loads from there.
if command -v update-initramfs >/dev/null; then
    update-initramfs -u
elif command -v dracut >/dev/null; then
    dracut -f
elif command -v mkinitcpio >/dev/null; then
    mkinitcpio -P
fi

# --- 3. apply live ------------------------------------------------------------
udevadm control --reload
udevadm trigger --subsystem-match=usbmisc --action=change || true
modprobe -r appledisplay 2>/dev/null || true

needs_reboot=0
current=$(cat /sys/module/usbhid/parameters/quirks 2>/dev/null || true)
for p in "${connected[@]}"; do
    case "$current" in *"0x05ac:0x$p:$QUIRK"*) ;; *) needs_reboot=1 ;; esac
done

if [ "$needs_reboot" -eq 1 ]; then
    echo "REBOOT_REQUIRED"
    echo "Setup done. Reboot to finish: one of your displays needs a driver option that only applies at boot."
else
    echo "Setup done."
fi
