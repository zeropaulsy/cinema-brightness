// SPDX-License-Identifier: GPL-2.0-or-later
// Quick Settings brightness slider for Apple Cinema / Studio Displays.
//
// Talks to a bundled long-running helper (helper/acd-helper.py) that keeps the
// displays' USB HID (hiddev) nodes open, so each brightness step costs ~5 ms.
// One-time root setup (udev access, usbhid quirk) lives in setup/install.sh and
// is offered from the slider's menu when it is needed.

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {QuickSlider, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

const MAX = 255;
const FADE_STEPS = 30; // steps per fade
// Gap between steps scales with the size of the jump: small nudges get the
// slow gap (smooth), a full 0->255 jump gets the fast gap (snappy).
// Each step also takes ~10 ms to reach the displays.
const SLOW_FRAME_MS = 15;
const FAST_FRAME_MS = 0;

function frameMsFor(dist) {
    const t = Math.min(1, Math.abs(dist) / MAX);
    return Math.round(SLOW_FRAME_MS + (FAST_FRAME_MS - SLOW_FRAME_MS) * t);
}

const PROBLEM_TEXT = {
    'no-hiddev': 'needs setup (or a reboot after setup)',
    'permission': 'needs setup (no access)',
    'error': 'not responding',
};

// Line-based JSON client for helper/acd-helper.py. Requests are serialised.
class HelperClient {
    constructor(path) {
        this._path = path;
        this._proc = null;
        this._queue = Promise.resolve();
    }

    _start() {
        this._proc = Gio.Subprocess.new(['python3', '-I', this._path],
            Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE);
        this._stdin = this._proc.get_stdin_pipe();
        this._stdout = new Gio.DataInputStream({
            base_stream: this._proc.get_stdout_pipe(),
            close_base_stream: true,
        });
    }

    _readLine() {
        return new Promise((resolve, reject) => {
            this._stdout.read_line_async(GLib.PRIORITY_DEFAULT, null, (s, res) => {
                try {
                    const [line] = s.read_line_finish_utf8(res);
                    if (line === null)
                        reject(new Error('helper exited'));
                    else
                        resolve(JSON.parse(line));
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    async _exchange(command) {
        if (!this._proc)
            this._start();
        try {
            this._stdin.write_all(new TextEncoder().encode(`${command}\n`), null);
            return await this._readLine();
        } catch (e) {
            // Helper died or broke: drop it so the next request restarts it.
            this.stop();
            throw e;
        }
    }

    request(command) {
        const result = this._queue.then(() => this._exchange(command));
        this._queue = result.catch(() => {});
        return result;
    }

    stop() {
        if (!this._proc)
            return;
        try {
            this._stdin.close(null);
        } catch (e) {}
        this._proc.force_exit();
        this._proc = null;
    }
}

const CinemaSlider = GObject.registerClass(
class CinemaSlider extends QuickSlider {
    _init(extension) {
        super._init({iconName: 'display-brightness-symbolic'});
        this._extension = extension;
        this._helper = new HelperClient(GLib.build_filenamev([extension.path, 'helper', 'acd-helper.py']));
        this._target = null;   // where the slider wants the displays to be
        this._current = null;  // last value actually sent to the displays
        this._animating = false;
        this._destroyed = false;
        this._sleepId = 0;

        this._sliderId = this.slider.connect('notify::value', () => this._onChanged());
        this.slider.accessible_name = 'Cinema Display Brightness';
        this.visible = false;

        this.menuEnabled = true;
        this.menu.setHeader('display-brightness-symbolic', 'Cinema Displays');
        this._statusSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._statusSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._setupItem = this.menu.addAction('Set Up Display Access…', () => this._runSetup());
        this._statusItems = []; // [{item, display}] for live label updates

        // Re-read when the dropdown itself opens, not only Quick Settings.
        this.menu.connect('open-state-changed', (menu, open) => {
            if (open)
                this.refresh();
        });

        this.refresh();
    }

    async refresh() {
        let reply;
        try {
            reply = await this._helper.request('scan');
        } catch (e) {
            console.error(`cinema-brightness: helper failed: ${e.message}`);
            this.visible = false;
            return;
        }
        if (this._destroyed)
            return;
        this._showStatus(reply.displays ?? []);
    }

    _showStatus(displays) {
        this.visible = displays.length > 0;
        const working = displays.filter(d => d.problem === null && d.brightness !== null);
        this.slider.reactive = working.length > 0;

        this._statusSection.removeAll();
        this._statusItems = [];
        for (const d of displays) {
            const item = new PopupMenu.PopupMenuItem('', {reactive: false});
            this._statusSection.addMenuItem(item);
            this._statusItems.push({item, display: d});
        }
        this._updateLabels();

        if (working.length && !this._animating) {
            this._current = working[0].brightness;
            this.slider.block_signal_handler(this._sliderId);
            this.slider.value = this._current / MAX;
            this.slider.unblock_signal_handler(this._sliderId);
        }
    }

    // Show each display's brightness; pass a value to show what was just sent.
    _updateLabels(value = null) {
        for (const {item, display: d} of this._statusItems) {
            if (value !== null && d.problem === null)
                d.brightness = value;
            const status = d.problem ? PROBLEM_TEXT[d.problem] ?? d.problem : `${d.brightness} / ${MAX}`;
            item.label.text = `${d.name}: ${status}`;
        }
    }

    _runSetup() {
        const script = GLib.build_filenamev([this._extension.path, 'setup', 'install.sh']);
        let proc;
        try {
            proc = Gio.Subprocess.new(['pkexec', 'bash', script],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
        } catch (e) {
            Main.notify('Cinema Display Brightness', `Could not run setup: ${e.message}`);
            return;
        }
        proc.communicate_utf8_async(null, null, (p, res) => {
            let out = '';
            try {
                [, out] = p.communicate_utf8_finish(res);
            } catch (e) {}
            if (!p.get_successful()) {
                if (p.get_exit_status() !== 126) // 126 = auth dialog dismissed
                    Main.notify('Cinema Display Brightness', `Setup failed:\n${out.trim().split('\n').slice(-3).join('\n')}`);
                return;
            }
            Main.notify('Cinema Display Brightness', out.includes('REBOOT_REQUIRED')
                ? 'Setup done. Reboot to finish enabling every display.'
                : 'Setup done.');
            // udev needs a moment to apply the new permissions.
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                if (!this._destroyed)
                    this.refresh();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _onChanged() {
        this._target = Math.round(this.slider.value * MAX);
        if (!this._animating)
            this._animate();
    }

    _sleep(ms) {
        return new Promise(resolve => {
            this._sleepId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                this._sleepId = 0;
                resolve();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    async _send(value) {
        try {
            await this._helper.request(`set ${value}`);
            if (!this._destroyed)
                this._updateLabels(value);
        } catch (e) {
            console.error(`cinema-brightness: set failed: ${e.message}`);
        }
    }

    // Split the distance into FADE_STEPS equal linear steps (step size 1 if
    // closer than that), frameMsFor(dist) apart. Re-plans if the slider moves.
    async _animate() {
        this._animating = true;
        if (this._current === null) {
            this._current = this._target;
            await this._send(this._current);
        }
        let plannedFor = null;
        let step = 1;
        let frameMs = SLOW_FRAME_MS;
        while (!this._destroyed && this._current !== this._target) {
            const dist = this._target - this._current;
            if (plannedFor !== this._target) {
                plannedFor = this._target;
                frameMs = frameMsFor(dist);
                step = Math.max(1, Math.floor(Math.abs(dist) / FADE_STEPS));
            }
            this._current += Math.sign(dist) * Math.min(step, Math.abs(dist));
            await this._send(this._current);
            if (this._current !== this._target)
                await this._sleep(frameMs);
        }
        this._animating = false;
    }

    destroy() {
        this._destroyed = true;
        if (this._sleepId) {
            GLib.source_remove(this._sleepId);
            this._sleepId = 0;
        }
        this._helper.stop();
        super.destroy();
    }
});

const CinemaIndicator = GObject.registerClass(
class CinemaIndicator extends SystemIndicator {
    _init(extension) {
        super._init();
        this.slider = new CinemaSlider(extension);
        this.quickSettingsItems.push(this.slider);
    }

    destroy() {
        this.quickSettingsItems.forEach(item => item.destroy());
        super.destroy();
    }
});

export default class CinemaBrightnessExtension extends Extension {
    enable() {
        this._indicator = new CinemaIndicator(this);
        const qs = Main.panel.statusArea.quickSettings;
        qs.addExternalIndicator(this._indicator, 2);
        this._menuId = qs.menu.connect('open-state-changed', (menu, open) => {
            if (open)
                this._indicator.slider.refresh();
        });
    }

    disable() {
        Main.panel.statusArea.quickSettings.menu.disconnect(this._menuId);
        this._indicator.destroy();
        this._indicator = null;
    }
}
