'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const { candidate, normalizeZone } = require('../lib/model');
const { SessionManager } = require('../lib/session');
const { ManagedS30API } = require('../lib/transport');
const { createEmulator } = require('./emulator.cjs');

const root = path.resolve(__dirname, '..');
function metadata(mode, single = false, overrides = {}) {
  const system = { name: 'Off temperature test', serialNumber: 'EMU-OFF', singleSetpointMode: single,
    hasTemperatureDeadband: true, hspCCspCSeparation: 1.5, hspCspSeparation: 3 };
  const zone = { id: 0, name: 'Main', systemMode: mode, temperatureC: 23, temperatureStatus: 'good',
    tempOperation: 'off', fan: false, hspC: 20, cspC: 25, spC: 22, heatingOption: true, coolingOption: true,
    minHspC: 10, maxHspC: 32, minCspC: 15.5, maxCspC: 35, ...overrides };
  return { system, zone, state: normalizeZone(system, zone), candidate: candidate(system, zone, '192.0.2.9') };
}

function deviceFixture(single = false) {
  const sessions = { commands: [], attach(host, serial, zoneId, onState, onUnavailable) {
    this.callbacks = { onState, onUnavailable }; return async () => { this.closed = true; };
  }, async command(...args) { this.commands.push(args); } };
  class Device {
    constructor() { this.settings = { host: '192.0.2.9', read_only: true, temperature_control_units: 'metric' };
      this.values = {}; this.capabilities = ['measure_temperature', 'thermostat_mode', 'hvac_state', 'fan_running', 'heat_target', 'cool_target', ...(single ? ['target_temperature'] : [])];
      this.options = {}; this.listeners = new Map(); this.removed = []; this.homey = { app: { sessions } }; }
    getSetting(id) { return this.settings[id]; }
    getStoreValue(id) { return { serial: 'EMU-OFF', zoneId: 0 }[id]; }
    hasCapability(id) { return this.capabilities.includes(id); }
    async addCapability(id) { this.capabilities.push(id); }
    async removeCapability(id) { this.removed.push(id); this.capabilities = this.capabilities.filter(value => value !== id); this.listeners.delete(id); }
    async setCapabilityOptions(id, options) { this.options[id] = options; }
    registerCapabilityListener(id, callback) { this.listeners.set(id, callback); }
    async setCapabilityValue(id, value) { this.values[id] = value; }
    getCapabilityValue(id) { return this.values[id]; }
    async setAvailable() { this.available = true; }
    async setUnavailable() { this.available = false; }
    error() {}
  }
  const filename = path.join(root, 'drivers/thermostat/device.js'), actualRequire = createRequire(filename), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports,
    require: name => name === 'homey' ? { Device } : actualRequire(name) }, { filename });
  const device = new module.exports();
  return { device, sessions, async emit(mode, overrides) {
    const next = metadata(mode, single, overrides);
    sessions.callbacks.onState(next.state, next.candidate); await device._updates; return next;
  } };
}

test('known Off puts only the actual current measurement into the thermostat presentation without synthesizing any target', () => {
  for (const single of [false, true]) {
    const off = metadata('off', single);
    assert.deepEqual(off.candidate.capabilitiesOptions.measure_temperature, { uiComponent: 'thermostat' });
    assert.equal(off.state.measure_temperature, 23);
    assert.deepEqual(off.candidate.nativeTargets, []);
    assert.deepEqual(off.candidate.adjustments, []);
    assert.equal(off.candidate.capabilities.some(id => /^target_temperature\./.test(id)), false);
    assert.equal(off.candidate.capabilities.filter(id => /^measure_temperature\./.test(id)).length, 0);
    assert.equal(off.state.target_temperature, single ? 22 : null, 'An existing SSP target remains actual historical data rather than being replaced by the measured temperature');
    if (single) assert.equal(off.candidate.capabilitiesOptions.target_temperature.uiComponent, null);
  }
});

test('known active modes restore the native sensor presentation while unknown or incomplete metadata does not override it', () => {
  for (const single of [false, true]) {
    for (const mode of ['heat', 'cool', 'heat and cool']) {
      assert.deepEqual(metadata(mode, single).candidate.capabilitiesOptions.measure_temperature, { uiComponent: 'sensor' });
    }
    const unknown = metadata('future-mode', single);
    assert.equal(Object.hasOwn(unknown.candidate.capabilitiesOptions, 'measure_temperature'), false);
  }
  const { system, zone } = metadata('off');
  system.singleSetpointMode = undefined;
  assert.equal(Object.hasOwn(candidate(system, zone, '192.0.2.9').capabilitiesOptions, 'measure_temperature'), false);
});

test('an existing device can move from every active mode through Off and back while preserving its measurement and legacy capability references', async () => {
  for (const single of [false, true]) {
    for (const mode of ['heat', 'cool', 'heat and cool']) {
      const context = deviceFixture(single), { device, sessions } = context;
      await device.onInit(); await context.emit(mode);
      const legacyHeat = device.listeners.get('heat_target');
      const references = ['measure_temperature', 'heat_target', 'cool_target', ...(single ? ['target_temperature'] : [])];
      await context.emit('off', { temperatureC: 24 });
      assert.equal(device.values.measure_temperature, 24);
      assert.equal(device.options.measure_temperature.uiComponent, 'thermostat');
      assert.ok(references.every(id => device.capabilities.includes(id)));
      assert.ok(references.every(id => !device.removed.includes(id)), 'Measurement/history/legacy Flow IDs must never be removed for this presentation change');
      assert.equal(device.capabilities.some(id => /^target_temperature\./.test(id)), false);
      assert.equal(device.listeners.has('measure_temperature'), false);
      assert.equal(sessions.commands.length, 0, 'Presentation updates must not command the thermostat');
      await context.emit(mode, { temperatureC: 24.5 });
      assert.equal(device.values.measure_temperature, 24.5);
      assert.equal(device.options.measure_temperature.uiComponent, 'sensor');
      assert.equal(device.listeners.get('heat_target'), legacyHeat);
      const native = single ? 'target_temperature' : mode === 'cool' ? 'target_temperature.cool' : 'target_temperature.heat';
      assert.equal(typeof device.listeners.get(native), 'function', 'Native write callbacks must be restored for an active target');
      assert.equal(sessions.commands.length, 0);
      await device.onUninit();
    }
  }
});

test('current readings retain their actual range and units, including zero, without using target bounds or inventing missing values', () => {
  for (const current of [-5, 0, 5, 23, 40]) {
    assert.equal(metadata('off', false, { temperatureC: current }).state.measure_temperature, current);
  }
  assert.equal(metadata('off', false, { temperatureC: null, temperature: 68 }).state.measure_temperature, 20);
  for (const value of [undefined, null, '23', Infinity, NaN]) {
    assert.equal(Object.hasOwn(metadata('off', false, { temperatureC: value, temperature: null }).state, 'measure_temperature'), false);
  }
  assert.equal(Object.hasOwn(metadata('off', false, { temperatureStatus: 'not_available' }).state, 'measure_temperature'), false);
});

test('actual Off-mode protocol readings become unavailable when stale or invalid instead of emitting a fabricated current value', async t => {
  let clock = 1000;
  const emulator = await createEmulator({ period: { systemMode: 'off' } });
  emulator.state.zones[0].status.temperatureC = 0;
  const manager = new SessionManager({ now: () => clock, sleep: async ms => { clock += ms; }, pollMs: 1, drainMs: 1,
    catalogSettleMs: 2, connectTimeoutMs: 100, refreshMs: Infinity, staleMs: 90000,
    clientFactory: () => new ManagedS30API({ host: emulator.host, port: emulator.port, protocol: emulator.protocol, requestTimeoutMs: 500 }) });
  t.after(async () => { await manager.close(); await emulator.close(); });
  const states = [], unavailable = [], session = manager.get(emulator.host);
  session.listeners.add({ serial: 'EMU-S40-001', zoneId: 0,
    onState: (state, next) => states.push({ state, candidate: next }), onUnavailable: error => unavailable.push(error) });
  await session.exclusive(() => session.connect());
  assert.equal(states.at(-1).state.measure_temperature, 0);
  assert.equal(states.at(-1).candidate.capabilitiesOptions.measure_temperature.uiComponent, 'thermostat');
  const count = states.length;
  clock += 90001; session.emit();
  assert.match(unavailable.at(-1), /stale/);
  assert.equal(states.length, count);
  emulator.enqueue({ zones: [{ id: 0, status: { temperatureC: null, temperature: null, temperatureStatus: 'not_available' } }] });
  await session.exclusive(() => session.poll());
  assert.match(unavailable.at(-1), /unavailable/);
  assert.equal(states.length, count);
  assert.equal(emulator.events.some(event => event.route === 'publish'), false);
});

test('the exact captured Homey 13.5.3 grouping method creates an Off measurement component and preserves the native history/Flow definition', {
  skip: process.env.HOMEY_REVIEWED_CORE_GROUPING ? false : 'Requires the temporary reviewed Homey core grouping source',
}, async () => {
  const source = fs.readFileSync(process.env.HOMEY_REVIEWED_CORE_GROUPING, 'utf8');
  assert.equal(createHash('sha256').update(source).digest('hex'), 'da27d051eebd8c6879ff9ad87e3f2c06328f6675129250d442598a74dc9f9318');
  const nativeFile = path.join(path.dirname(process.env.HOMEY_REVIEWED_CORE_GROUPING), 'core-measure-temperature-13.5.3.json');
  const nativeSource = fs.readFileSync(nativeFile);
  assert.equal(createHash('sha256').update(nativeSource).digest('hex'), '1ac569f5f4a961c3e39160b2ccbc7973bc7e9ed9a5e8dc6f4c175302bfd63e1f');
  const native = JSON.parse(nativeSource), manifest = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  assert.equal(native.uiComponent, 'sensor'); assert.equal(native.getable, true); assert.equal(native.setable, false);
  assert.equal(native.insights, true);
  assert.ok(native.$flow.triggers.some(trigger => trigger.id === 'measure_temperature_changed'));
  const core = vm.runInNewContext(`({${source}})`, {
    CAPABILITIES_TYPES: { BOOLEAN: 'boolean' },
    CAPABILITIES_UI_COMPONENTS: { THERMOSTAT: 'thermostat', SENSOR: 'sensor', PICKER: 'picker', BUTTON: 'button', MEDIA: 'media' },
    CAPABILITIES_UI_COMPONENTS_DEFAULT: { number: { getable: 'sensor', setable: 'slider' }, boolean: { getable: 'sensor', setable: 'toggle' }, enum: { getable: 'sensor', setable: 'picker' } },
  });
  for (const single of [false, true]) {
    const context = deviceFixture(single), { device } = context;
    await device.onInit();
    for (const mode of ['heat', 'off', 'heat']) {
      await context.emit(mode);
      const { ui } = await core.onInitUI.call({ capabilities: device.capabilities,
        async getCapabilitiesOptions() { return device.options; },
        async getCapability({ capabilityId }) {
          if (capabilityId.startsWith('measure_temperature')) return native;
          if (capabilityId.startsWith('target_temperature')) return { type: 'number', getable: true, setable: true, uiComponent: 'thermostat' };
          if (capabilityId.startsWith('thermostat_mode')) return { type: 'enum', getable: true, setable: true, uiComponent: 'picker' };
          return manifest.capabilities[capabilityId];
        }, getCapabilityGetable(definition) { return definition.getable; }, addQuickActionOverrideUIGetter(value) { return value; },
        error(error) { throw error; },
      });
      const thermostat = ui.components.find(component => component.id === 'thermostat');
      assert.ok(thermostat);
      if (mode === 'off') {
        assert.ok(thermostat.capabilities.includes('measure_temperature'));
        assert.ok(!thermostat.capabilities.some(id => /^target_temperature\./.test(id)));
        assert.equal(thermostat.capabilities.includes('target_temperature'), single, 'Core prepass retains a real SSP target; the web read-only branch must handle this case too');
      } else if (!single) {
        assert.ok(thermostat.capabilities.includes('target_temperature.heat'));
        assert.ok(!thermostat.capabilities.includes('measure_temperature'));
      }
    }
    await device.onUninit();
  }
});
