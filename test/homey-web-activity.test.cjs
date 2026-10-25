'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
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
  return [...(tree.type === type ? [tree] : []), ...nodes(tree.props?.children, type)];
}
const overlay = tree => nodes(tree, 'svg').filter(node => node.props['data-lennox-activity']);

function harness({ rendererSource = activity.AFTER, onWrite = () => Promise.resolve(), driverId = 'homey:app:com.metalcated.lennox:thermostat', hookCapability, requestTimeout = 45000 } = {}) {
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
  capabilities.hvac_state = { id: 'hvac_state', value: 'unknown', getable: true, setable: false };
  capabilities.fan_running = { id: 'fan_running', value: null, getable: true, setable: false };
  const component = { capabilities: ['target_temperature.heat', 'target_temperature.cool'] };
  if (hookCapability && !capabilities[hookCapability]) capabilities[hookCapability] = { id: hookCapability, value: 74, getable: true, setable: true };
  const hookCounts = [], slots = [], requests = [], instanceWrites = [], toasts = [], listeners = new Map(), timers = new Map();
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
    setTimeout: setTimer, clearTimeout: clearTimer });
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
  return { device, component, hookCounts, requests, instanceWrites, toasts, timers, render,
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

test('the indicator uses actual activity with heating/cooling priority and no selected-mode or fan-mode inference', () => {
  for (const online of [false, null, undefined, 'true', 1]) {
    assert.equal(activity.renderActivity({ online, activity: 'heating', fanRunning: true }), null);
  }
  for (const [operation, expected] of [['heating', 'heating'], ['cooling', 'cooling'], ['idle', 'fan'], ['unknown', 'fan'], ['defrost', 'fan'], [null, 'fan']]) {
    const tree = activity.renderActivity({ online: true, activity: operation, fanRunning: true });
    assert.equal(tree.props['data-lennox-activity'], expected);
    assert.equal(tree.props['data-fan-running'], true);
    assert.equal(nodes(tree, 'svg').filter(node => node.props['data-activity-fan']).length, expected === 'fan' ? 1 : 0, 'Only one primary glyph is shown');
  }
  for (const fanRunning of [false, null, undefined, 'true', 1, {}]) {
    assert.equal(activity.renderActivity({ online: true, activity: 'idle', fanRunning, fanMode: 'on', thermostatMode: 'heat' }), null);
  }
});

test('the glyph has an accessible actual-state label, ignores pointer input and scopes animation with a reduced-motion override', () => {
  const heat = activity.renderActivity({ online: true, activity: 'heating', fanRunning: false });
  const cool = activity.renderActivity({ online: true, activity: 'cooling', fanRunning: false });
  const fan = activity.renderActivity({ online: true, activity: 'idle', fanRunning: true });
  assert.equal(heat.props['aria-label'], 'Heating is running');
  assert.equal(cool.props['aria-label'], 'Cooling is running');
  assert.equal(fan.props['aria-label'], 'Fan is running');
  for (const tree of [heat, cool, fan]) {
    assert.equal(tree.props.role, 'img');
    assert.equal(tree.props.focusable, 'false');
    assert.equal(tree.props.style.pointerEvents, 'none');
    assert.equal(nodes(tree, 'button').length, 0);
    assert.equal(nodes(tree, 'path').length, 3);
    assert.ok(nodes(tree, 'style')[0].props.children.includes('prefers-reduced-motion'));
  }
  const heatWave = nodes(heat, 'g').find(node => node.props.className === 'lennoxActivityWave1353');
  const coolWave = nodes(cool, 'g').find(node => node.props.className === 'lennoxActivityWave1353');
  assert.notEqual(heatWave.props.stroke, coolWave.props.stroke);
  assert.equal(heatWave.props['data-direction'], 'heating');
  assert.equal(coolWave.props['data-direction'], 'cooling');
  assert.equal(nodes(fan, 'g').find(node => node.props.className === 'lennoxActivityRotor1353').props.fill, '#e8edf3');
  assert.equal(nodes(fan, 'svg').find(node => node.props['data-activity-fan']).props.viewBox, '0 0 48 48');
  assert.ok(nodes(fan, 'g').some(node => node.props.transform === 'translate(24 24)'), 'The rotor is centered inside a positive local SVG viewBox');
  assert.doesNotMatch(activity.ACTIVITY_CSS, /stroke-dasharray|stroke-dashoffset/, 'Running heat/cool indicators use solid wave strokes');
  assert.match(activity.ACTIVITY_CSS, /@media\s*\(prefers-reduced-motion\s*:\s*reduce\)\s*\{[^}]*animation\s*:\s*none\s*!important/s);
  assert.match(activity.ACTIVITY_CSS, /@keyframes lennoxActivityWaveFlow1353/);
  assert.match(activity.ACTIVITY_CSS, /@keyframes lennoxActivitySpin1353/);
  assert.doesNotMatch(activity.ACTIVITY_CSS, /(?:^|\n)\s*(?:svg|path|g|\*)\s*\{/);
  assert.equal(activity.activityFixtureSvg({ online: false, activity: 'heating' }), '');
});

test('actual capability socket events switch activity without hook-order changes or thermostat writes', () => {
  const rendered = harness();
  assert.equal(overlay(rendered.render()).length, 0);
  rendered.device.capabilitiesObj.thermostat_mode.value = 'heat';
  rendered.device.capabilitiesObj['measure_temperature.heat'].value = 40;
  assert.equal(overlay(rendered.render()).length, 0, 'A heating mode and apparent target demand do not establish actual operation');
  let tree = rendered.socketReport('hvac_state', 'heating');
  assert.equal(overlay(tree)[0].props['data-lennox-activity'], 'heating');
  assert.equal(rendered.device.capabilitiesObj.hvac_state.value, 'unknown', 'The socket event is independent of stale device metadata');
  tree = rendered.socketReport('fan_running', true);
  assert.equal(overlay(tree)[0].props['data-fan-running'], true);
  assert.equal(overlay(tree)[0].props['data-lennox-activity'], 'heating');
  tree = rendered.socketReport('hvac_state', 'cooling');
  assert.equal(overlay(tree)[0].props['data-lennox-activity'], 'cooling');
  tree = rendered.socketReport('hvac_state', 'idle');
  assert.equal(overlay(tree)[0].props['data-lennox-activity'], 'fan');
  tree = rendered.socketReport('fan_running', null);
  assert.equal(overlay(tree).length, 0);
  rendered.socketReport('fan_running', 'true');
  assert.equal(overlay(rendered.render()).length, 0);
  rendered.socketReport('fan_running', true);
  for (const ready of [false, null]) {
    rendered.device.ready = ready;
    assert.equal(overlay(rendered.render()).length, 0);
  }
  rendered.device.ready = true;
  rendered.device.available = false;
  assert.equal(overlay(rendered.render()).length, 0);
  rendered.device.available = true;
  assert.equal(overlay(rendered.render())[0].props['data-lennox-activity'], 'fan');
  rendered.device.driverId = 'homey:app:other.vendor:thermostat';
  assert.equal(overlay(rendered.render()).length, 0);
  assert.equal(new Set(rendered.hookCounts).size, 1, 'Activity transitions must not introduce conditional React hooks');
  assert.equal(rendered.requests.length, 0);
  assert.equal(rendered.instanceWrites.length, 0);
});

test('read-only and missing-adjustment devices can display actual activity while other thermostats retain their original dial', () => {
  const rendered = harness();
  rendered.device.settings.read_only = true;
  rendered.render();
  rendered.socketReport('hvac_state', 'cooling');
  assert.equal(overlay(rendered.render())[0].props['data-lennox-activity'], 'cooling');
  assert.ok(nodes(rendered.render(), 'button').every(button => button.props.disabled));
  for (const id of ['heat_decrease', 'heat_increase', 'cool_decrease', 'cool_increase']) delete rendered.device.capabilitiesObj[id];
  assert.equal(nodes(rendered.render(), 'button').length, 0);
  assert.equal(overlay(rendered.render())[0].props['data-lennox-activity'], 'cooling');
  const other = harness({ driverId: 'homey:app:other.vendor:thermostat' });
  other.device.capabilitiesObj.hvac_state.value = 'heating';
  other.device.capabilitiesObj.fan_running.value = true;
  assert.equal(overlay(other.render()).length, 0);
  assert.equal(nodes(other.render(), 'dial').length, 1);
  assert.equal(other.requests.length, 0);
});

test('activity changes preserve immediate previews, native dragging and the absolute-before-relative queue ordering', async () => {
  const absolute = deferred(), relative = deferred();
  const rendered = harness({ onWrite: request => request.capabilityId.startsWith('target_temperature') ? absolute.promise : relative.promise });
  nodes(rendered.render(), 'dial')[0].props.onTargetValueChange(76);
  assert.equal(rendered.value(), 76);
  await rendered.advance(100);
  rendered.click(1);
  rendered.socketReport('hvac_state', 'heating');
  assert.equal(rendered.value(), 77);
  await rendered.advance(600);
  assert.equal(rendered.requests.length, 0);
  await rendered.advance(300);
  assert.equal(rendered.requests[0].capabilityId, 'target_temperature.heat');
  assert.equal(rendered.requests[0].value, 76);
  rendered.socketReport('target_temperature.heat', 76);
  absolute.resolve(); await settle();
  assert.equal(rendered.value(), 77);
  assert.equal(rendered.requests[1].capabilityId, 'heat_increase');
  assert.equal(rendered.requests[1].opts.steps, 1);
  rendered.socketReport('fan_running', true);
  rendered.socketReport('target_temperature.heat', 77);
  relative.resolve(); await settle();
  assert.equal(rendered.value(), 77);
  assert.ok(rendered.requests.every(request => !['hvac_state', 'fan_running', 'fan_mode'].includes(request.capabilityId)));
});

test('activity transformation requires one exact prior renderer and preserves existing files on refusal', () => {
  assert.equal(activity.BEFORE, patches.PREVIEW_AFTER);
  assert.equal(activity.transformSource(activity.BEFORE), activity.AFTER);
  assert.throws(() => activity.transformSource(''), /found 0/);
  assert.throws(() => activity.transformSource(activity.BEFORE + activity.BEFORE), /found 2/);
  assert.throws(() => activity.transformSource(activity.AFTER), /found 0/);
  assert.throws(() => activity.patchBundle(Buffer.from(activity.BEFORE)), /exact reviewed/);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'homey-activity-test-'));
  const input = path.join(directory, 'input.js'), output = path.join(directory, 'output.js');
  fs.writeFileSync(input, activity.BEFORE); fs.writeFileSync(output, 'keep-existing-output');
  assert.throws(() => activity.writePatchedBundle(input, input), /separate/);
  assert.throws(() => activity.writePatchedBundle(input, output), /already exists/);
  assert.equal(fs.readFileSync(input, 'utf8'), activity.BEFORE);
  assert.equal(fs.readFileSync(output, 'utf8'), 'keep-existing-output');
});

test('the exact reviewed bundle gets only the activity layer and reverses to the pinned preview with its writer hook unchanged', {
  skip: process.env.HOMEY_REVIEWED_WEB_BUNDLE ? false : 'Requires the reviewed vendor bundle',
}, () => {
  const selected = Buffer.from(selection(icons(fs.readFileSync(process.env.HOMEY_REVIEWED_WEB_BUNDLE, 'utf8'))));
  const queued = patches.patchCoalescedBundle(controls(selected).output).output;
  const previous = patches.patchPreviewBundle(queued).output;
  const { output, report } = activity.patchBundle(previous);
  assert.equal(report.replacements, 1);
  assert.equal(report.originalSha256, activity.EXPECTED_SHA256);
  assert.equal(createHash('sha256').update(output).digest('hex'), report.patchedSha256);
  const deployment = fs.readFileSync(path.join(__dirname, '../scripts/manage-homey-web-activity.py'), 'utf8');
  const deploymentConstant = name => {
    const match = deployment.match(new RegExp(`^${name} = "([a-f0-9]{64})"$`, 'm'));
    assert.ok(match, `The activity deployment wrapper must pin a complete ${name}`);
    return match[1];
  };
  assert.equal(deploymentConstant('ORIGINAL_SHA256'), activity.EXPECTED_SHA256);
  assert.equal(deploymentConstant('PATCHED_SHA256'), report.patchedSha256);
  assert.equal(deploymentConstant('GUARDS_SHA256'), '677f7c8e9d3c528273ab1b40aa3b1d9f095f30a95021510210c1d150bf03d10d');
  assert.equal(deploymentConstant('GUARDS_SHA256'), createHash('sha256').update(fs.readFileSync(path.join(__dirname, '../scripts/manage-homey-web-icons.py'))).digest('hex'));
  assert.equal(output.toString().replace(activity.AFTER, activity.BEFORE), previous.toString(), 'Every other vendor function, including PSe and the native writer hook, stays byte-identical');
  assert.equal(output.toString().split(patches.PREVIEW_HOOK_AFTER).length - 1, 1);
});
