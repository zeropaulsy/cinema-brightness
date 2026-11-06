# Cinema Display Brightness

A GNOME Shell extension that adds a brightness slider to Quick Settings for
Apple Cinema and Studio Displays connected over USB. These displays take
brightness over USB HID, not DDC/CI, so GNOME's own slider doesn't show up
for them.

- Controls every connected display at once, with smooth fades.
- No compiled code. A small bundled Python 3 helper talks to the displays
  directly (about 5 ms per step).
- One-click setup from the slider's menu for the parts that need root.

Requires GNOME Shell 50 and `python3`.

## Supported displays

Vendor `05ac`, products `9215 9217 9218 9219 921b 921c 921d 921e 9221 9222
9226 9227 9232 9236` (Studio Display 15"/17", Cinema Display 20"/23"/24"/30",
Cinema HD 23"/27"/30", LED Cinema 24").

## Install

```bash
./pack.sh
gnome-extensions install --force dist/cinema-brightness@zeropaulsy.shell-extension.zip
```

Log out and back in (Wayland), then enable it in the Extensions app.

## First-time setup

Open Quick Settings, click the arrow next to the brightness slider and choose
**Set Up Display Access…**. This runs `setup/install.sh` as root through
`pkexec`. You can also run it yourself with `sudo bash setup/install.sh`. It:

1. Adds `/etc/udev/rules.d/70-cinema-brightness.rules`, which gives the
   logged-in user access to the displays (`TAG+="uaccess"`).
2. Adds `/etc/modprobe.d/zz-cinema-brightness.conf`. Some models (`9218 9219
   921c 921d 9222 9226 9236`) are normally claimed by the kernel's
   `appledisplay` driver, and usbhid ignores them. The file sets the usbhid
   quirk `NO_IGNORE|HIDDEV_FORCE` (`0x40000010`) and blacklists
   `appledisplay`. It also regenerates the initramfs.

Those models need **a reboot** after setup, because the usbhid quirk can't be
changed while the system is running. Other models work straight away.

To undo it: `sudo bash setup/uninstall.sh`.

## Command line

```bash
python3 helper/acd-helper.py --list      # displays, brightness, problems
python3 helper/acd-helper.py --set 128   # set all displays
```

## License

GPL-2.0-or-later. Based on what was learned from
[acdcontrol](https://github.com/warvariuc/acdcontrol).
