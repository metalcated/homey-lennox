'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const motion = require('../scripts/patch-homey-13.5.3-activity-motion.cjs');
const activity = require('../scripts/patch-homey-13.5.3-activity.cjs');
const buttons = require('../scripts/patch-homey-13.5.3-thermostat-buttons.cjs');
const { transformSource: icons } = require('../scripts/patch-homey-13.5.3-web-icons.cjs');
const { transformSource: selection } = require('../scripts/patch-homey-13.5.3-thermostat.cjs');
const { patchBundle: controls } = require('../scripts/patch-homey-13.5.3-controls.cjs');

function block(source, selector) {
  const start = source.indexOf(selector);
  assert.ok(start >= 0, `Missing CSS selector ${selector}`);
  const open = source.indexOf('{', start);
  let depth = 1;
  for (let index = open + 1; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}' && --depth === 0) return source.slice(open + 1, index);
  }
  assert.fail(`Unclosed CSS block ${selector}`);
}
function nodes(tree, type) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(child => nodes(child, type));
  return [...(tree.type === type ? [tree] : []), ...nodes(tree.props?.children, type)];
}
function restoreCss(value) {
  if (value === motion.SMOOTH_CSS) return activity.ACTIVITY_CSS;
  if (Array.isArray(value)) return value.map(restoreCss);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, restoreCss(child)]));
  return value;
}

test('wave motion has invisible reset endpoints and constant-direction linear travel with staggered phases', () => {
  const frames = block(motion.SMOOTH_CSS, '@keyframes lennoxActivityWaveFlow1353');
  const first = block(frames, '0%');
  const last = block(frames, '100%');
  assert.match(first, /opacity\s*:\s*0(?:;|$)/);
  assert.match(last, /opacity\s*:\s*0(?:;|$)/);
  assert.match(first, /translate3d\(0,\s*4px,\s*0\)/);
  assert.match(last, /translate3d\(0,\s*-4px,\s*0\)/);
  assert.match(block(frames, '25%,75%'), /opacity\s*:\s*1(?:;|$)/);
  const rule = block(motion.SMOOTH_CSS, '.lennoxActivityWave1353>path');
  assert.match(rule, /animation\s*:\s*lennoxActivityWaveFlow1353\s+2\.4s\s+linear\s+infinite/);
  assert.doesNotMatch(rule, /ease|alternate|steps\(/);
  assert.match(block(motion.SMOOTH_CSS, '.lennoxActivityWave1353>path:nth-child(2)'), /animation-delay\s*:\s*-\.4s/);
  assert.match(block(motion.SMOOTH_CSS, '.lennoxActivityWave1353>path:nth-child(3)'), /animation-delay\s*:\s*-\.8s/);
  assert.match(block(motion.SMOOTH_CSS, '.lennoxActivityWave1353[data-direction="cooling"]>path'), /animation-direction\s*:\s*reverse/);
  assert.doesNotMatch(motion.SMOOTH_CSS, /stroke-dasharray|stroke-dashoffset/, 'The wave strokes remain solid');
});

test('the fan rotates slowly at a linear constant speed without changing its established SVG center', () => {
  const rule = block(motion.SMOOTH_CSS, '.lennoxActivityRotor1353');
  assert.match(rule, /animation\s*:\s*lennoxActivitySpin1353\s+2\.4s\s+linear\s+infinite/);
  assert.match(rule, /transform-box\s*:\s*view-box/);
  assert.match(rule, /transform-origin\s*:\s*50%\s+50%/);
  assert.doesNotMatch(rule, /ease|alternate|steps\(/);
  const frames = block(motion.SMOOTH_CSS, '@keyframes lennoxActivitySpin1353');
  assert.match(block(frames, 'from'), /rotate\(0deg\)/);
  assert.match(block(frames, 'to'), /rotate\(360deg\)/);
  const fan = motion.renderActivity({ online: true, activity: 'idle', fanRunning: true });
  assert.equal(nodes(fan, 'svg').find(node => node.props['data-activity-fan']).props.viewBox, '0 0 48 48');
  assert.ok(nodes(fan, 'g').some(node => node.props.transform === 'translate(24 24)'));
});

test('reduced motion freezes visible glyphs, clears active rendering hints and keeps CSS scoped to the Lennox activity elements', () => {
  const reduced = block(motion.SMOOTH_CSS, '@media (prefers-reduced-motion:reduce)');
  const staticRule = block(reduced, '.lennoxActivityWave1353>path,.lennoxActivityRotor1353');
  assert.match(staticRule, /animation\s*:\s*none\s*!important/);
  assert.match(staticRule, /will-change\s*:\s*auto(?:;|$)/);
  assert.doesNotMatch(block(motion.SMOOTH_CSS, '.lennoxActivityWave1353>path'), /(?:^|;)\s*opacity\s*:\s*0(?:;|$)/,
    'When animation is disabled, the base wave retains its default visible opacity');
  for (const state of [{ activity: 'heating', fanRunning: true }, { activity: 'cooling', fanRunning: false }, { activity: 'idle', fanRunning: true }]) {
    const tree = motion.renderActivity({ online: true, ...state });
    for (const node of nodes(tree, 'path')) {
      assert.notEqual(node.props.opacity, 0);
      assert.notEqual(node.props.style?.opacity, 0);
    }
    assert.equal(tree.props.style.pointerEvents, 'none');
    assert.ok(nodes(tree, 'style')[0].props.children.includes('prefers-reduced-motion'));
  }
  assert.doesNotMatch(motion.SMOOTH_CSS, /(?:^|\n)\s*(?:svg|path|g|\*)\s*\{/);
});

test('the real renderer and appearance fixture preserve telemetry decisions, accessibility and geometry with only their CSS changed', () => {
  for (const online of [true, false]) {
    for (const actual of ['heating', 'cooling', 'idle', 'defrost', 'unknown', null]) {
      for (const fanRunning of [true, false, null, 'true']) {
        const state = { online, activity: actual, fanRunning };
        const before = activity.renderActivity(state), after = motion.renderActivity(state);
        assert.deepEqual(restoreCss(after), before);
        if (after !== null) {
          assert.equal(nodes(after, 'style')[0].props.children, motion.SMOOTH_CSS);
          assert.equal(after.props.role, 'img');
          assert.equal(after.props['aria-label'], before.props['aria-label']);
        }
        const oldSvg = activity.activityFixtureSvg(state), newSvg = motion.activityFixtureSvg(state);
        assert.equal(newSvg === '' ? '' : newSvg.replace(motion.SMOOTH_CSS, activity.ACTIVITY_CSS), oldSvg);
      }
    }
  }
});

test('the entire actual renderer keeps its previous hooks, event handlers and queue code byte-identical outside the CSS literal', () => {
  assert.equal(motion.BEFORE, activity.AFTER);
  assert.equal(motion.AFTER.replace(JSON.stringify(motion.SMOOTH_CSS), JSON.stringify(activity.ACTIVITY_CSS)), motion.BEFORE);
  assert.equal(motion.SMOOTH_RENDERER_SOURCE.replace(JSON.stringify(motion.SMOOTH_CSS), JSON.stringify(activity.ACTIVITY_CSS)), activity.ACTIVITY_RENDERER_SOURCE);
  assert.equal(motion.transformSource(motion.BEFORE), motion.AFTER);
  assert.equal(motion.DRIVER_ID, activity.DRIVER_ID);
});

test('motion transformation refuses missing, repeated, already-patched and unsupported sources without overwriting existing files', () => {
  assert.throws(() => motion.transformSource(null), /JavaScript source/);
  assert.throws(() => motion.transformSource(''), /found 0/);
  assert.throws(() => motion.transformSource(motion.BEFORE + motion.BEFORE), /found 2/);
  assert.throws(() => motion.transformSource(motion.AFTER), /found 0/);
  assert.throws(() => motion.patchBundle(Buffer.from(motion.BEFORE)), /exact reviewed actual-activity/);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'homey-activity-motion-'));
  const input = path.join(directory, 'input.js'), output = path.join(directory, 'output.js');
  fs.writeFileSync(input, motion.BEFORE); fs.writeFileSync(output, 'keep-existing');
  assert.throws(() => motion.writePatchedBundle(input, input), /separate/);
  assert.throws(() => motion.writePatchedBundle(input, output), /already exists/);
  assert.equal(fs.readFileSync(input, 'utf8'), motion.BEFORE);
  assert.equal(fs.readFileSync(output, 'utf8'), 'keep-existing');
});

test('the full reviewed bundle composes, passes ESM syntax validation and reverses exactly while deployment pins match', {
  skip: process.env.HOMEY_REVIEWED_WEB_BUNDLE ? false : 'Requires the reviewed vendor bundle',
}, () => {
  const selected = Buffer.from(selection(icons(fs.readFileSync(process.env.HOMEY_REVIEWED_WEB_BUNDLE, 'utf8'))));
  const queued = buttons.patchCoalescedBundle(controls(selected).output).output;
  const preview = buttons.patchPreviewBundle(queued).output;
  const previous = activity.patchBundle(preview).output;
  const { output, report } = motion.patchBundle(previous);
  assert.equal(report.originalSha256, motion.EXPECTED_SHA256);
  assert.equal(report.patchedSha256, createHash('sha256').update(output).digest('hex'));
  assert.equal(report.replacements, 1);
  assert.equal(output.toString().replace(motion.AFTER, motion.BEFORE), previous.toString(), 'PSe, capability writer hooks, drag and queue code remain outside the CSS-only patch');
  assert.equal(output.toString().split(buttons.PREVIEW_HOOK_AFTER).length - 1, 1);
  const deployment = fs.readFileSync(path.join(__dirname, '../scripts/manage-homey-web-motion.py'), 'utf8');
  const deploymentConstant = name => {
    const match = deployment.match(new RegExp(`^${name} = "([a-f0-9]{64})"$`, 'm'));
    assert.ok(match, `The deployment wrapper must pin a complete ${name}`);
    return match[1];
  };
  assert.equal(deploymentConstant('ORIGINAL_SHA256'), motion.EXPECTED_SHA256);
  assert.equal(deploymentConstant('PATCHED_SHA256'), report.patchedSha256);
  assert.equal(deploymentConstant('GUARDS_SHA256'), '677f7c8e9d3c528273ab1b40aa3b1d9f095f30a95021510210c1d150bf03d10d');
  assert.equal(deploymentConstant('GUARDS_SHA256'), createHash('sha256').update(fs.readFileSync(path.join(__dirname, '../scripts/manage-homey-web-icons.py'))).digest('hex'));
});
