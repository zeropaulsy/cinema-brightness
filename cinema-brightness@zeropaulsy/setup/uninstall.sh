#!/bin/bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Undo install.sh. Run as root.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo "This script must be run as root (e.g. sudo $0)." >&2
    exit 1
fi

rm -fv /etc/udev/rules.d/70-cinema-brightness.rules /etc/modprobe.d/zz-cinema-brightness.conf

if command -v update-initramfs >/dev/null; then
    update-initramfs -u
elif command -v dracut >/dev/null; then
    dracut -f
elif command -v mkinitcpio >/dev/null; then
    mkinitcpio -P
fi

udevadm control --reload
echo "Removed. Reboot to return the displays to the default kernel drivers."
