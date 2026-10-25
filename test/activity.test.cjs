'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const { ManagedS30API } = require('../lib/transport');
const { SessionManager } = require('../lib/session');
const { normalizeZone, candidate } = require('../lib/model');
const { createEmulator } = require('./emulator.cjs');

const root = path.resolve(__dirname, '..');
const basicSystem = { serialNumber: 'EMU-ACTIVITY', name: 'Activity test', singleSetpointMode: false };
const basicZone = { id: 0, name: 'Main', temperatureC: 22, temperatureStatus: 'good', systemMode: 'heat and cool',
  heatingOption: true, coolingOption: true, hspC: 20, cspC: 25, minHspC: 10, maxHspC: 32, minCspC: 15.5, maxCspC: 35 };

test('fan activity accepts only actual boolean running reports and never infers demand from a configured fan mode', () => {
  for (const fanMode of ['auto', 'on', 'circulate', null]) {
    for (const fan of [true, false, null, undefined, 'true', 'false', 0, 1, {}, []]) {
      const state = normalizeZone(basicSystem, { ...basicZone, fanMode, fan, tempOperation: 'off' });
      assert.equal(state.fan_running, typeof fan === 'boolean' ? fan : null, `${fanMode}: ${String(fan)}`);
      assert.equal(state.hvac_state, 'idle');
    }
  }
});

test('actual HVAC activity remains independent of selected mode, target demand and simultaneous fan operation', () => {
  for (const [tempOperation, expected] of [['heating', 'heating'], ['cooling', 'cooling'], ['off', 'idle'], ['idle', 'idle'],
    ['defrost', 'defrost'], ['unknown', 'unknown'], [undefined, 'unknown'], [true, 'unknown']]) {
    for (const fan of [true, false]) {
      const state = normalizeZone(basicSystem, { ...basicZone, systemMode: 'off', temperatureC: 5, tempOperation, fan });
      assert.equal(state.hvac_state, expected);
      assert.equal(state.fan_running, fan);
    }
  }
});

test('fan activity is a hidden read-only capability, including devices whose first reading is unknown', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  const definition = manifest.capabilities.fan_running;
  assert.equal(definition.type, 'boolean');
  assert.equal(definition.getable, true);
  assert.equal(definition.setable, false);
  assert.equal(definition.uiComponent, null);
  const metadata = candidate(basicSystem, basicZone, '192.0.2.8');
  assert.ok(metadata.capabilities.includes('fan_running'));
  assert.equal(metadata.capabilitiesOptions.fan_running.uiComponent, null);
  assert.equal(normalizeZone(basicSystem, basicZone).fan_running, null);
  assert.ok(!JSON.stringify(manifest.flow ?? {}).includes('fan_running'), 'Activity display must not create fan commands or Flow actions');
});

async function wireFixture(t, initial = {}) {
  const emulator = await createEmulator();
  Object.assign(emulator.state.zones[0].status, initial);
  const api = new ManagedS30API({ host: emulator.host, port: emulator.port, protocol: emulator.protocol, requestTimeoutMs: 500 });
  t.after(async () => { await api.close(); await emulator.close(); });
  await api.serverConnect();
  const system = api.getSystem('LCC');
  await api.subscribe(system); await api.messagePump();
  return { emulator, api, system, zone: system.getZone(0) };
}

test('the real HTTP parser preserves literal fan reports and per-field provenance without publishing thermostat commands', async t => {
  const { emulator, api, system, zone } = await wireFixture(t, { fan: false, tempOperation: 'off' });
  assert.equal(zone.fan, false);
  assert.equal(zone.activityTracked, true);
  let clock = 1000;
  let reports = { fan: { time: clock }, tempOperation: { time: clock } };
  const read = () => normalizeZone(system, zone, { now: clock, staleMs: 90000, reports });
  assert.equal(read().fan_running, false);
  let revisions = { ...api.activityRevisions.get(0) };
  for (const value of [true, false, null, 'false', 1, {}]) {
    clock++;
    emulator.enqueue({ zones: [{ id: 0, status: { fan: value } }] });
    await api.messagePump();
    assert.deepEqual(zone.fan, value);
    const next = { ...api.activityRevisions.get(0) };
    assert.ok(next.fan > revisions.fan);
    assert.equal(next.tempOperation, revisions.tempOperation, 'A fan report must not refresh HVAC-operation provenance');
    reports = { ...reports, fan: { time: clock } };
    assert.equal(read().fan_running, typeof value === 'boolean' ? value : null);
    revisions = next;
  }
  emulator.enqueue({ zones: [{ id: 0, status: { humidity: 44, period: { fanMode: 'on' } } }] });
  await api.messagePump();
  assert.deepEqual(api.activityRevisions.get(0), revisions, 'Omitted activity fields do not advance their revisions');
  assert.equal(emulator.events.some(event => event.route === 'publish'), false);
});

test('tracked raw fields require freshness evidence instead of presenting cached values as current activity', async t => {
  const { system, zone } = await wireFixture(t, { fan: true, tempOperation: 'heating' });
  assert.equal(normalizeZone(system, zone).fan_running, null);
  assert.equal(normalizeZone(system, zone).hvac_state, 'unknown');
  for (const age of [0, 89999, 90000, 90001]) {
    const state = normalizeZone(system, zone, { now: 100000 + age, staleMs: 90000,
      reports: { fan: { time: 100000 }, tempOperation: { time: 100000 } } });
    assert.equal(state.fan_running, age <= 90000 ? true : null);
    assert.equal(state.hvac_state, age <= 90000 ? 'heating' : 'unknown');
  }
});

test('a missing initial activity field stays unknown even when the configured fan mode requests continuous operation', async t => {
  const { api, emulator, system, zone } = await wireFixture(t, { fan: undefined, tempOperation: undefined });
  assert.equal(zone.fan, null);
  assert.equal(zone.tempOperation, null);
  emulator.enqueue({ zones: [{ id: 0, status: { period: { fanMode: 'on' } } }] });
  await api.messagePump();
  const state = normalizeZone(system, zone, { now: 1000, staleMs: 90000, reports: {} });
  assert.equal(state.fan_mode, 'on');
  assert.equal(state.fan_running, null);
  assert.equal(state.hvac_state, 'unknown');
  emulator.enqueue({ zones: [{ id: 0, status: { fan: 'true', tempOperation: { running: 'heating' } } }] });
  await api.messagePump();
  const malformed = normalizeZone(system, zone, { now: 3000, staleMs: 90000,
    reports: { fan: { time: 3000 }, tempOperation: { time: 3000 } } });
  assert.equal(malformed.fan_running, null);
  assert.equal(malformed.hvac_state, 'unknown');
});

test('explicit null or malformed status clears an earlier true/heating report instead of refreshing the cached activity', async t => {
  const { api, emulator, system, zone } = await wireFixture(t, { fan: true, tempOperation: 'heating' });
  const prior = { ...api.activityRevisions.get(0) };
  emulator.enqueue({ zones: [{ id: 0, status: { fan: null, tempOperation: null } }] });
  await api.messagePump();
  assert.equal(zone.fan, null);
  assert.equal(zone.tempOperation, null);
  assert.ok(api.activityRevisions.get(0).fan > prior.fan);
  assert.ok(api.activityRevisions.get(0).tempOperation > prior.tempOperation);
  const state = normalizeZone(system, zone, { now: 2000, staleMs: 90000,
    reports: { fan: { time: 2000 }, tempOperation: { time: 2000 } } });
  assert.equal(state.fan_running, null);
  assert.equal(state.hvac_state, 'unknown');
});

test('fresh temperature and period traffic cannot keep omitted fan or HVAC activity alive beyond the shared freshness budget', async t => {
  let clock = 1000;
  const emulator = await createEmulator();
  emulator.state.zones[0].status.fan = true;
  emulator.state.zones[0].status.tempOperation = 'heating';
  const manager = new SessionManager({ now: () => clock, sleep: async ms => { clock += ms; }, pollMs: 1,
    drainMs: 1, catalogSettleMs: 2, connectTimeoutMs: 100, staleMs: 90000, refreshMs: Infinity,
    clientFactory: () => new ManagedS30API({ host: emulator.host, port: emulator.port, protocol: emulator.protocol, requestTimeoutMs: 500 }) });
  t.after(async () => { await manager.close(); await emulator.close(); });
  const states = [], unavailable = [];
  const session = manager.get(emulator.host);
  session.listeners.add({ serial: 'EMU-S40-001', zoneId: 0, onState: state => states.push({ ...state }), onUnavailable: error => unavailable.push(error) });
  await session.exclusive(() => session.connect());
  assert.equal(states.at(-1).fan_running, true);
  assert.equal(states.at(-1).hvac_state, 'heating');
  const initial = structuredClone(session.activityData.get(0));
  clock += 89990;
  emulator.enqueue({ zones: [{ id: 0, status: { temperature: 73, temperatureC: 23, temperatureStatus: 'good', period: { fanMode: 'on' } } }] });
  await session.exclusive(() => session.poll());
  assert.equal(states.at(-1).fan_running, true);
  assert.deepEqual(session.activityData.get(0), initial);
  clock += 20;
  emulator.enqueue({ zones: [{ id: 0, status: { temperature: 74, temperatureC: 23.5, temperatureStatus: 'good' } }] });
  await session.exclusive(() => session.poll());
  assert.equal(states.at(-1).fan_running, null);
  assert.equal(states.at(-1).hvac_state, 'unknown');
  assert.equal(unavailable.length, 0, 'The device can remain online with fresh temperatures while activity is unknown');
  emulator.enqueue({ zones: [{ id: 0, status: { fan: false, tempOperation: 'off' } }] });
  await session.exclusive(() => session.poll());
  assert.equal(states.at(-1).fan_running, false);
  assert.equal(states.at(-1).hvac_state, 'idle');
  clock += 100000;
  session.readyState = false;
  await session.exclusive(() => session.connect());
  assert.equal(states.at(-1).fan_running, true, 'Reconnect reads fresh actual activity instead of retaining an old field revision');
  assert.equal(states.at(-1).hvac_state, 'heating');
  assert.ok(session.activityData.get(0).fan.time > initial.fan.time);
  assert.equal(emulator.events.some(event => event.route === 'publish'), false);
});

function deviceFixture() {
  const sessions = { commands: [], attach(host, serial, zoneId, onState, onUnavailable) {
    this.callbacks = { onState, onUnavailable }; return async () => { this.closed = true; };
  }, async command(...args) { this.commands.push(args); } };
  class Device {
    constructor() { this.settings = { host: '192.0.2.8', read_only: false }; this.values = {}; this.capabilities = ['measure_temperature', 'thermostat_mode', 'hvac_state'];
      this.options = {}; this.listeners = new Map(); this.homey = { app: { sessions } }; }
    getSetting(id) { return this.settings[id]; }
    getStoreValue(id) { return { serial: 'EMU-ACTIVITY', zoneId: 0 }[id]; }
    hasCapability(id) { return this.capabilities.includes(id); }
    async addCapability(id) { this.capabilities.push(id); }
    async removeCapability(id) { this.capabilities = this.capabilities.filter(value => value !== id); }
    async setCapabilityOptions(id, options) { this.options[id] = options; }
    registerCapabilityListener(id, callback) { this.listeners.set(id, callback); }
    async setCapabilityValue(id, value) { if (this.valueGate) await this.valueGate(id, value); this.values[id] = value; }
    getCapabilityValue(id) { return this.values[id]; }
    async setAvailable() { this.available = true; }
    async setUnavailable() { this.available = false; }
    error() {}
  }
  const filename = path.join(root, 'drivers/thermostat/device.js'), actualRequire = createRequire(filename), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports,
    require: name => name === 'homey' ? { Device } : actualRequire(name) }, { filename });
  return { device: new module.exports(), sessions };
}

test('an existing device gains hidden fan telemetry, clears it on unavailable, and never registers a fan-running write listener', async () => {
  const { device, sessions } = deviceFixture();
  await device.onInit();
  const metadata = candidate(basicSystem, { ...basicZone, fan: true }, device.settings.host);
  sessions.callbacks.onState(normalizeZone(basicSystem, { ...basicZone, fan: true, tempOperation: 'heating' }), metadata);
  await device._updates;
  assert.equal(device.available, true);
  assert.equal(device.values.fan_running, true);
  assert.ok(device.capabilities.includes('fan_running'));
  assert.equal(device.options.fan_running.uiComponent, null);
  assert.equal(device.listeners.has('fan_running'), false);
  sessions.callbacks.onUnavailable('Emulated connection lost'); await device._updates;
  assert.equal(device.available, false);
  assert.equal(device.values.fan_running, null);
  sessions.callbacks.onState(normalizeZone(basicSystem, { ...basicZone, fan: false, tempOperation: 'off' }), metadata);
  await device._updates;
  assert.equal(device.available, true);
  assert.equal(device.values.fan_running, false);
  assert.equal(sessions.commands.length, 0);
  await device.onUninit();
  assert.equal(sessions.closed, true);
});

test('shutdown waits for an already pending telemetry update before clearing fan activity and releasing resources', async () => {
  const { device, sessions } = deviceFixture();
  await device.onInit();
  let release, started;
  const blocked = new Promise(resolve => { release = resolve; });
  const pending = new Promise(resolve => { started = resolve; });
  device.valueGate = (id, value) => { if (id === 'fan_running' && value === true) { started(); return blocked; } };
  sessions.callbacks.onState({ fan_running: true }, candidate(basicSystem, { ...basicZone, fan: true }, device.settings.host));
  await pending;
  const closing = device.onUninit();
  release(); await closing;
  assert.equal(device.values.fan_running, null, 'An old in-flight true update cannot restore activity after shutdown');
  assert.equal(sessions.closed, true);
  assert.equal(sessions.commands.length, 0);
});
