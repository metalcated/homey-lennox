'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const off = require('../scripts/patch-homey-13.5.3-off-temperature.cjs');
const motion = require('../scripts/patch-homey-13.5.3-activity-motion.cjs');
const activity = require('../scripts/patch-homey-13.5.3-activity.cjs');
const patches = require('../scripts/patch-homey-13.5.3-thermostat-buttons.cjs');
const { transformSource: icons } = require('../scripts/patch-homey-13.5.3-web-icons.cjs');
const { transformSource: selection } = require('../scripts/patch-homey-13.5.3-thermostat.cjs');
const { patchBundle: controls } = require('../scripts/patch-homey-13.5.3-controls.cjs');
const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const plain = value => JSON.parse(JSON.stringify(value));
function nodes(tree, type) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(child => nodes(child, type));
  return [...(type === undefined || tree.type === type ? [tree] : []), ...nodes(tree.props?.children, type)];
}
const reading = tree => nodes(tree, 'svg').find(node => node.props['data-lennox-off-temperature']);
function assertReadOnly(tree) {
  assert.ok(reading(tree));
  for (const type of ['dial', 'button', 'input', 'selector']) assert.equal(nodes(tree, type).length, 0);
  for (const node of nodes(tree)) {
    assert.ok(!Object.entries(node.props || {}).some(([key, value]) => /^on[A-Z]/.test(key) && typeof value === 'function'), 'The Off view must not expose drag, keyboard or click handlers');
  }
  assert.equal(reading(tree).props.focusable, 'false');
}

function harness({ rendererSource = off.AFTER, onWrite = () => Promise.resolve(), driverId = 'homey:app:com.metalcated.lennox:thermostat', hookCapability, requestTimeout = 45000 } = {}) {
  const device = { id: 'preview-device', driverId, available: true, ready: true,
    settings: { read_only: false, temperature_control_units: 'imperial' }, capabilitiesObj: {} };
  const capabilities = device.capabilitiesObj;
  capabilities.thermostat_mode = { id: 'thermostat_mode', value: 'auto', getable: true, setable: true };
  for (const kind of ['heat', 'cool']) {
    for (const [prefix, value] of [['target_temperature', kind === 'heat' ? 74 : 80], ['measure_temperature', 73], ['thermostat_mode', kind]]) {
      const id = `${prefix}.${kind}`;
      capabilities[id] = { id, value, getable: true, setable: prefix === 'target_temperature', min: 40, max: 90, step: 1, units: '°F', decimals: 0 };
    }
    for (const direction of ['decrease', 'increase']) {
      const id = `${kind}_${direction}`;
      capabilities[id] = { id, value: null, getable: false, setable: true };
    }
  }
  capabilities.measure_temperature = { id: 'measure_temperature', value: 73, units: '°F', decimals: 0, getable: true, setable: false };
  capabilities.hvac_state = { id: 'hvac_state', value: 'unknown', getable: true, setable: false };
  capabilities.fan_running = { id: 'fan_running', value: null, getable: true, setable: false };
  const component = { capabilities: ['target_temperature.heat', 'target_temperature.cool'] };
  if (hookCapability && !capabilities[hookCapability]) capabilities[hookCapability] = { id: hookCapability, value: 74, getable: true, setable: true };
  const backgrounds = [], hookCounts = [], slots = [], requests = [], instanceWrites = [], toasts = [], listeners = new Map(), timers = new Map();
  let cursor = 0, effects = [], dirty = false, mounted = true, now = 0, sequence = 0;
  const setTimer = (callback, delay) => { const id = ++sequence; timers.set(id, { callback, at: now + Number(delay) }); return id; };
  const clearTimer = id => timers.delete(id);
  const same = (left, right) => left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  const instance = { id: device.id, manager: { setCapabilityValue(request) { requests.push(plain(request)); return Promise.resolve().then(() => onWrite(request)); } },
    makeCapabilityInstance(id, callback) {
      const subscribers = listeners.get(id) ?? new Set();
      listeners.set(id, subscribers); subscribers.add(callback);
      return { setValue: value => { const request = { capabilityId: id, value }; instanceWrites.push(request); return Promise.resolve().then(() => onWrite(request)); }, destroy: () => subscribers.delete(callback) };
    } };
  const react = {
    useState(initial) { const id = cursor++; if (!Object.hasOwn(slots, id)) slots[id] = typeof initial === 'function' ? initial() : initial;
      return [slots[id], value => { const next = typeof value === 'function' ? value(slots[id]) : value; if (!Object.is(next, slots[id])) { slots[id] = next; dirty = true; } }]; },
    useRef(initial) { const id = cursor++; if (!Object.hasOwn(slots, id)) slots[id] = { current: initial }; return slots[id]; },
    useMemo(work, dependencies) { const id = cursor++; if (!slots[id] || !same(slots[id].dependencies, dependencies)) slots[id] = { dependencies, value: work() }; return slots[id].value; },
    useEffect(work, dependencies) { const id = cursor++; if (!slots[id] || !same(slots[id].dependencies, dependencies)) {
      slots[id]?.cleanup?.(); slots[id] = { dependencies }; effects.push(() => { slots[id].cleanup = work(); }); } },
  };
  const context = vm.createContext({ P: react, WN: () => ({ device, deviceInstance: instance }),
    WE: callback => callback, q: { handleError: error => toasts.push(error.message) }, KI: { default: callback => callback },
    L: { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    R: type => () => type, uR: 'root', fR: 'header', lR: 'selector', dR: 'body', PSe: 'dial',
    bz: value => backgrounds.push(value), zbe: mode => 'neutral:'+mode, setTimeout: setTimer, clearTimeout: clearTimer });
  const source = hookCapability === undefined ? rendererSource
    : `function VSe(e){return pR({deviceId:e.deviceId,capabilityId:${JSON.stringify(hookCapability)},requestTimeout:${JSON.stringify(requestTimeout)}})}`;
  vm.runInContext(patches.PREVIEW_HOOK_AFTER + '\n' + source, context);
  function render() {
    assert.equal(mounted, true);
    for (let pass = 0; pass < 10; pass++) {
      cursor = 0; effects = []; dirty = false;
      const tree = context.VSe({ deviceId: device.id, component });
      hookCounts.push(cursor);
      for (const effect of effects) effect();
      if (!dirty) return tree;
    }
    throw Error('Preview renderer did not settle');
  }
  return { device, component, backgrounds, hookCounts, requests, instanceWrites, toasts, timers, render,
    value: () => nodes(render(), 'dial')[0].props.targetValue,
    click(direction) { const button = nodes(render(), 'button')[direction < 0 ? 0 : 1]; assert.ok(button && !button.props.disabled);
      button.props.onClick({ stopPropagation() {} }); return render(); },
    report(id, value) { capabilities[id] = { ...capabilities[id], value }; for (const callback of listeners.get(id) ?? []) callback(value); return render(); },
    socketReport(id, value) { for (const callback of listeners.get(id) ?? []) callback(value); return render(); },
    async advance(milliseconds) {
      const until = now + milliseconds;
      while (true) {
        const [id, task] = [...timers.entries()].sort((left, right) => left[1].at - right[1].at)[0] ?? [];
        if (!task || task.at > until) break;
        now = task.at; timers.delete(id); task.callback(); await settle(); if (mounted) render();
      }
      now = until; await settle(); return mounted ? render() : undefined;
    },
    unmount() { mounted = false; for (const slot of slots) slot?.cleanup?.(); },
  };
}

test('the actual read-only helper displays the reported temperature in its actual units without target-range clamping', () => {
  for (const [value, decimals, units, displayed] of [[73, 0, '°F', '73°'], [23.25, 1, '°C', '23.3°'], [0, 1, '°C', '0.0°'], [-5, 0, '°C', '-5°'], [100, 0, '°F', '100°']]) {
    const tree = off.renderOffTemperature({ online: true, value, decimals, units, mode: 'off' });
    assertReadOnly(tree);
    assert.equal(nodes(tree, 'text')[0].props.children, displayed);
    assert.equal(nodes(tree, 'text')[1].props.children, 'Off');
    assert.ok(tree.props['aria-label'].includes(units));
    assert.ok(tree.props['aria-label'].includes('thermostat Off'));
    assert.equal(tree.props.role, 'img');
  }
  for (const value of [undefined, null, NaN, Infinity, '73']) {
    const tree = off.renderOffTemperature({ online: true, value, mode: 'off' });
    assert.equal(nodes(tree, 'text')[0].props.children, '—');
    assert.match(tree.props['aria-label'], /unavailable/);
  }
  const offline = off.renderOffTemperature({ online: false, value: 73, mode: 'off' });
  assert.equal(nodes(offline, 'text')[0].props.children, '—');
  const unknown = off.renderOffTemperature({ online: true, value: 23, mode: 'future-mode' });
  assert.equal(nodes(unknown, 'text')[1].props.children, 'Current temperature');
  assert.doesNotMatch(unknown.props['aria-label'], /thermostat Off/);
});

test('an open active dial switches immediately to actual read-only temperature on Off before capability grouping catches up', () => {
  for (const mode of ['heat', 'cool', 'auto']) {
    const rendered = harness();
    rendered.device.capabilitiesObj.thermostat_mode.value = mode;
    assert.equal(nodes(rendered.render(), 'dial').length, 1);
    let tree = rendered.socketReport('thermostat_mode', 'off');
    assertReadOnly(tree);
    assert.equal(nodes(reading(tree), 'text')[0].props.children, '73°');
    assert.equal(rendered.device.capabilitiesObj.thermostat_mode.value, mode, 'Socket events need not update the metadata snapshot first');
    assert.ok(rendered.component.capabilities.includes('target_temperature.heat'), 'The event arrives while old target grouping is still mounted');
    tree = rendered.socketReport('measure_temperature', 74);
    assert.equal(nodes(reading(tree), 'text')[0].props.children, '74°');
    assert.equal(rendered.device.capabilitiesObj.measure_temperature.value, 73);
    rendered.component.capabilities = ['measure_temperature'];
    for (const id of ['target_temperature.heat', 'target_temperature.cool']) delete rendered.device.capabilitiesObj[id];
    assertReadOnly(rendered.render());
    assert.equal(new Set(rendered.hookCounts).size, 1, 'Changing modes and core groups cannot alter React hook order');
    assert.ok(rendered.backgrounds.includes('neutral:off'));
    assert.equal(rendered.requests.length, 0);
    assert.equal(rendered.instanceWrites.length, 0);
  }
});

test('unknown, missing or unavailable measurements never become an invented temperature or a false Off label', () => {
  const rendered = harness();
  rendered.render(); rendered.socketReport('thermostat_mode', 'off');
  for (const value of [null, '73', NaN, Infinity]) {
    const tree = rendered.socketReport('measure_temperature', value);
    assert.equal(nodes(reading(tree), 'text')[0].props.children, '—');
  }
  rendered.socketReport('measure_temperature', 73);
  for (const change of [() => { rendered.device.available = false; }, () => { rendered.device.available = true; rendered.device.ready = false; }]) {
    change();
    assert.equal(nodes(reading(rendered.render()), 'text')[0].props.children, '—');
  }
  rendered.device.available = true; rendered.device.ready = true;
  rendered.component.capabilities = ['measure_temperature'];
  for (const id of ['target_temperature.heat', 'target_temperature.cool']) delete rendered.device.capabilitiesObj[id];
  let tree = rendered.socketReport('thermostat_mode', 'future-mode');
  assertReadOnly(tree);
  assert.equal(nodes(reading(tree), 'text')[1].props.children, 'Current temperature');
  rendered.device.capabilitiesObj.measure_temperature = { ...rendered.device.capabilitiesObj.measure_temperature, value: 0, units: '°C', decimals: 1 };
  assert.equal(nodes(reading(rendered.render()), 'text')[0].props.children, '0.0°');
  delete rendered.device.capabilitiesObj.measure_temperature;
  tree = rendered.render();
  assertReadOnly(tree);
  assert.equal(nodes(reading(tree), 'text')[0].props.children, '—');
  assert.equal(rendered.requests.length, 0);
});

test('Off cancels an unsent relative adjustment and active mode restores the existing immediate-preview queue', async () => {
  const rendered = harness();
  const capturedIncrease = nodes(rendered.render(), 'button')[1].props.onClick;
  rendered.click(1); await rendered.advance(100);
  assertReadOnly(rendered.socketReport('thermostat_mode', 'off'));
  capturedIncrease({ stopPropagation() {} });
  await rendered.advance(1500);
  assert.equal(rendered.requests.length, 0);
  rendered.socketReport('thermostat_mode', 'heat');
  assert.equal(nodes(rendered.render(), 'dial').length, 1);
  rendered.click(1);
  assert.equal(rendered.value(), 75);
  await rendered.advance(600);
  assert.deepEqual(rendered.requests.map(request => [request.capabilityId, request.opts?.steps]), [['heat_increase', 1]]);
});

test('SSP Off retains actual target data but cancels a pending drag and blocks a previously captured active drag callback', async () => {
  const rendered = harness();
  rendered.component.capabilities = ['measure_temperature', 'target_temperature'];
  rendered.device.capabilitiesObj.target_temperature = { ...rendered.device.capabilitiesObj['target_temperature.heat'], id: 'target_temperature', value: 74 };
  for (const direction of ['decrease', 'increase']) rendered.device.capabilitiesObj[`target_${direction}`] = { id: `target_${direction}`, getable: false, setable: true };
  const captured = nodes(rendered.render(), 'dial')[0].props.onTargetValueChange;
  captured(76); await rendered.advance(100);
  assertReadOnly(rendered.socketReport('thermostat_mode', 'off'));
  assert.equal(rendered.device.capabilitiesObj.target_temperature.value, 74);
  captured(78);
  await rendered.advance(1500);
  assert.equal(rendered.requests.length, 0, 'A stale active callback cannot enqueue an SSP target while the visible view is read-only');
  rendered.socketReport('thermostat_mode', 'heat');
  nodes(rendered.render(), 'dial')[0].props.onTargetValueChange(76);
  await rendered.advance(1000);
  assert.equal(rendered.requests.length, 1);
  assert.equal(rendered.requests[0].capabilityId, 'target_temperature');
  assert.equal(rendered.requests[0].value, 76);
});

test('Off remains read-only regardless of command permission, keeps smooth actual activity, and does not replace other vendors views', () => {
  const rendered = harness();
  rendered.render(); rendered.socketReport('thermostat_mode', 'off');
  rendered.socketReport('fan_running', true);
  for (const readOnly of [false, true]) {
    rendered.device.settings.read_only = readOnly;
    const tree = rendered.render();
    assertReadOnly(tree);
    const fan = nodes(tree, 'svg').find(node => node.props['data-lennox-activity']);
    assert.equal(fan.props['data-lennox-activity'], 'fan');
    assert.equal(nodes(fan, 'style')[0].props.children, motion.SMOOTH_CSS);
  }
  const other = harness({ driverId: 'homey:app:other.vendor:thermostat' });
  other.device.capabilitiesObj.thermostat_mode.value = 'off';
  assert.equal(reading(other.render()), undefined);
  assert.equal(nodes(other.render(), 'dial').length, 1);
  assert.equal(other.backgrounds.length, 0);
});

test('the read-only layer enforces strict source guards and preserves the exact prior web layer for reversal', {
  skip: process.env.HOMEY_REVIEWED_WEB_BUNDLE ? false : 'Requires the reviewed vendor bundle',
}, () => {
  const selected = Buffer.from(selection(icons(fs.readFileSync(process.env.HOMEY_REVIEWED_WEB_BUNDLE, 'utf8'))));
  const queued = patches.patchCoalescedBundle(controls(selected).output).output;
  const preview = patches.patchPreviewBundle(queued).output;
  const previous = motion.patchBundle(activity.patchBundle(preview).output).output;
  const { output, report } = off.patchBundle(previous);
  assert.equal(report.originalSha256, off.EXPECTED_SHA256);
  assert.equal(report.patchedSha256, createHash('sha256').update(output).digest('hex'));
  assert.equal(report.replacements, 1);
  assert.equal(output.toString().replace(off.AFTER, off.BEFORE), previous.toString());
  assert.equal(output.toString().split(patches.PREVIEW_HOOK_AFTER).length - 1, 1);
  assert.equal(off.BEFORE, motion.AFTER);
  assert.throws(() => off.transformSource(''), /found 0/);
  assert.throws(() => off.transformSource(off.BEFORE + off.BEFORE), /found 2/);
  assert.throws(() => off.transformSource(off.AFTER), /found 0/);
  assert.throws(() => off.patchBundle(Buffer.from(off.BEFORE)), /exact reviewed/);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'homey-off-temperature-'));
  const input = path.join(directory, 'input.js'), existing = path.join(directory, 'existing.js');
  fs.writeFileSync(input, previous); fs.writeFileSync(existing, 'keep-existing');
  assert.throws(() => off.writePatchedBundle(input, input), /separate/);
  assert.throws(() => off.writePatchedBundle(input, existing), /already exists/);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'keep-existing');
  const deployment = fs.readFileSync(path.join(__dirname, '../scripts/manage-homey-web-off-temperature.py'), 'utf8');
  const deploymentConstant = name => {
    const match = deployment.match(new RegExp(`^${name} = "([a-f0-9]{64})"$`, 'm'));
    assert.ok(match, `The deployment wrapper must pin a complete ${name}`);
    return match[1];
  };
  assert.equal(deploymentConstant('ORIGINAL_SHA256'), off.EXPECTED_SHA256);
  assert.equal(deploymentConstant('PATCHED_SHA256'), report.patchedSha256);
  assert.equal(deploymentConstant('GUARDS_SHA256'), '677f7c8e9d3c528273ab1b40aa3b1d9f095f30a95021510210c1d150bf03d10d');
  assert.equal(deploymentConstant('GUARDS_SHA256'), createHash('sha256').update(fs.readFileSync(path.join(__dirname, '../scripts/manage-homey-web-icons.py'))).digest('hex'));
});
