#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Brightness helper for Apple Cinema / Studio Displays (USB HID, hiddev).

Long-running process driven by the Cinema Display Brightness GNOME extension.
Keeping the device nodes open avoids re-initialising them on every step, which
makes a brightness change take ~5 ms instead of ~70 ms per call.

Protocol: one command per line on stdin, one JSON object per line on stdout.
    scan        -> {"displays": [...]}     (re-detect, open new devices)
    get         -> {"displays": [...]}     (current brightness of each)
    set <0-255> -> {"ok": true, "failed": N}
    quit        -> exits

Each display entry: {"id", "name", "path", "brightness", "problem"} where
problem is null, "no-hiddev" (kernel driver/quirk setup or reboot needed)
or "permission" (udev rule missing).

Can also be run by hand:  acd-helper.py --list   /   acd-helper.py --set 128
"""

import ctypes
import errno
import fcntl
import glob
import json
import os
import sys

APPLE = 0x05AC
SUPPORTED = {
    0x9215: 'Apple Studio Display 15"',
    0x9217: 'Apple Studio Display 17"',
    0x9218: 'Apple Cinema Display 23"',
    0x9219: 'Apple Cinema Display 20"',
    0x921B: 'Apple Cinema Display 20"',
    0x921C: 'Apple Cinema HD Display 23"',
    0x921D: 'Apple Cinema Display 20"',
    0x921E: 'Apple Cinema Display 24"',
    0x9221: 'Apple Cinema HD Display 30"',
    0x9222: 'Apple Cinema Display 20"',
    0x9226: 'Apple Cinema HD Display 27"',
    0x9227: 'Apple Cinema HD Display 27"',
    0x9232: 'Apple Cinema HD Display 30"',
    0x9236: 'Apple LED Cinema Display 24"',
}

HID_REPORT_TYPE_FEATURE = 3
BRIGHTNESS_REPORT = 16
BRIGHTNESS_USAGE = 0x820010


class UsageRef(ctypes.Structure):
    _fields_ = [('report_type', ctypes.c_uint), ('report_id', ctypes.c_uint),
                ('field_index', ctypes.c_uint), ('usage_index', ctypes.c_uint),
                ('usage_code', ctypes.c_uint), ('value', ctypes.c_int)]


class ReportInfo(ctypes.Structure):
    _fields_ = [('report_type', ctypes.c_uint), ('report_id', ctypes.c_uint),
                ('num_fields', ctypes.c_uint)]


def _ioc(direction, nr, size):
    return (direction << 30) | (size << 16) | (ord('H') << 8) | nr


HIDIOCINITREPORT = _ioc(0, 0x05, 0)
HIDIOCGREPORT = _ioc(1, 0x07, ctypes.sizeof(ReportInfo))
HIDIOCSREPORT = _ioc(1, 0x08, ctypes.sizeof(ReportInfo))
HIDIOCGUSAGE = _ioc(3, 0x0B, ctypes.sizeof(UsageRef))
HIDIOCSUSAGE = _ioc(1, 0x0C, ctypes.sizeof(UsageRef))


def _read(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return None


class Display:
    def __init__(self, usb_id, product):
        self.id = usb_id            # sysfs USB device name, e.g. "1-1.2"
        self.product = product
        self.name = SUPPORTED[product]
        self.path = None
        self.fd = None
        self.problem = None

    def open(self, path):
        self.path = path
        try:
            self.fd = os.open(path, os.O_RDWR | os.O_CLOEXEC)
            fcntl.ioctl(self.fd, HIDIOCINITREPORT, 0)
            self.problem = None
        except OSError as e:
            self.close()
            self.problem = 'permission' if e.errno in (errno.EACCES, errno.EPERM) else 'error'

    def close(self):
        if self.fd is not None:
            try:
                os.close(self.fd)
            except OSError:
                pass
        self.fd = None

    def _refs(self, value=0):
        usage = UsageRef(HID_REPORT_TYPE_FEATURE, BRIGHTNESS_REPORT, 0, 0,
                         BRIGHTNESS_USAGE, value)
        report = ReportInfo(HID_REPORT_TYPE_FEATURE, BRIGHTNESS_REPORT, 1)
        return usage, report

    def get(self):
        if self.fd is None:
            return None
        usage, report = self._refs()
        fcntl.ioctl(self.fd, HIDIOCGREPORT, report)
        fcntl.ioctl(self.fd, HIDIOCGUSAGE, usage)
        return usage.value

    def set(self, value):
        usage, report = self._refs(value)
        fcntl.ioctl(self.fd, HIDIOCSUSAGE, usage)
        fcntl.ioctl(self.fd, HIDIOCSREPORT, report)

    def info(self):
        brightness = None
        if self.fd is not None:
            try:
                brightness = self.get()
            except OSError:
                self.close()
                self.problem = 'error'
        return {'id': self.id, 'name': self.name, 'path': self.path,
                'brightness': brightness, 'problem': self.problem}


def find_hiddev(usb_dir):
    for node in sorted(glob.glob(os.path.join(usb_dir, '*:*', 'usbmisc', 'hiddev*'))):
        name = os.path.basename(node)
        for dev in (f'/dev/usb/{name}', f'/dev/{name}'):
            if os.path.exists(dev):
                return dev
    return None


class Helper:
    def __init__(self):
        self.displays = {}  # usb id -> Display

    def scan(self):
        seen = set()
        for usb_dir in glob.glob('/sys/bus/usb/devices/*'):
            if ':' in os.path.basename(usb_dir):
                continue
            if _read(os.path.join(usb_dir, 'idVendor')) != f'{APPLE:04x}':
                continue
            try:
                product = int(_read(os.path.join(usb_dir, 'idProduct')) or '', 16)
            except ValueError:
                continue
            if product not in SUPPORTED:
                continue
            usb_id = os.path.basename(usb_dir)
            seen.add(usb_id)
            disp = self.displays.get(usb_id)
            if disp is None:
                disp = self.displays[usb_id] = Display(usb_id, product)
            path = find_hiddev(usb_dir)
            if disp.fd is not None and path == disp.path:
                continue  # still open and unchanged
            disp.close()
            if path is None:
                disp.path, disp.problem = None, 'no-hiddev'
            else:
                disp.open(path)
        for usb_id in list(self.displays):
            if usb_id not in seen:
                self.displays.pop(usb_id).close()

    def listing(self):
        return {'displays': [d.info() for _, d in sorted(self.displays.items())]}

    def set(self, value):
        value = max(0, min(255, int(value)))
        failed = 0
        for disp in self.displays.values():
            if disp.fd is None:
                continue
            try:
                disp.set(value)
            except OSError:
                disp.close()
                disp.problem = 'error'
                failed += 1
        return {'ok': failed == 0, 'failed': failed}

    def handle(self, line):
        cmd, _, arg = line.strip().partition(' ')
        if cmd == 'scan':
            self.scan()
            return self.listing()
        if cmd == 'get':
            return self.listing()
        if cmd == 'set':
            return self.set(arg)
        return {'error': f'unknown command: {cmd}'}


def main():
    helper = Helper()
    helper.scan()

    if len(sys.argv) > 1:  # manual use
        if sys.argv[1] == '--set' and len(sys.argv) > 2:
            print(json.dumps(helper.set(sys.argv[2])))
        else:
            print(json.dumps(helper.listing(), indent=2))
        return

    for line in sys.stdin:
        if line.strip() == 'quit':
            break
        try:
            reply = helper.handle(line)
        except Exception as e:  # never die mid-session; report instead
            reply = {'error': str(e)}
        sys.stdout.write(json.dumps(reply) + '\n')
        sys.stdout.flush()


if __name__ == '__main__':
    main()
