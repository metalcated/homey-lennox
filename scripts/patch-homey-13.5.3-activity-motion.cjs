#!/usr/bin/env node
'use strict';

// Optional CSS-only follow-up for the exact reviewed actual-activity layer.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const activity = require('./patch-homey-13.5.3-activity.cjs');
const EXPECTED_SHA256 = 'fde675312b7b0009e57b10ee75de531524a7f25ef1200efe4faf54bf2c83dd3a';
const DRIVER_ID = activity.DRIVER_ID;
const BEFORE = activity.AFTER;
const SMOOTH_CSS = `
.lennoxActivityWave1353>path{animation:lennoxActivityWaveFlow1353 2.4s linear infinite;will-change:transform,opacity}
.lennoxActivityWave1353>path:nth-child(2){animation-delay:-.4s}
.lennoxActivityWave1353>path:nth-child(3){animation-delay:-.8s}
.lennoxActivityWave1353[data-direction="cooling"]>path{animation-direction:reverse}
.lennoxActivityRotor1353{transform-box:view-box;transform-origin:50% 50%;animation:lennoxActivitySpin1353 2.4s linear infinite;will-change:transform}
@keyframes lennoxActivityWaveFlow1353{0%{transform:translate3d(0,4px,0);opacity:0}25%,75%{opacity:1}100%{transform:translate3d(0,-4px,0);opacity:0}}
@keyframes lennoxActivitySpin1353{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.lennoxActivityWave1353>path,.lennoxActivityRotor1353{animation:none!important;will-change:auto}}
`.trim();
function replaceOnce(source, before, after) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw Error(`Expected one reviewed activity-motion fragment; found ${count}`);
  return source.replace(before, after);
}
const CSS_BEFORE = JSON.stringify(activity.ACTIVITY_CSS);
const CSS_AFTER = JSON.stringify(SMOOTH_CSS);
const AFTER = replaceOnce(BEFORE, CSS_BEFORE, CSS_AFTER);
const SMOOTH_RENDERER_SOURCE = replaceOnce(activity.ACTIVITY_RENDERER_SOURCE, CSS_BEFORE, CSS_AFTER);
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
function transformSource(source) {
  if (typeof source !== 'string') throw Error('Expected JavaScript source text');
  return replaceOnce(source, BEFORE, AFTER);
}
function patchBundle(input) {
  if (!Buffer.isBuffer(input) || sha256(input) !== EXPECTED_SHA256) throw Error('Unsupported Homey bundle; the exact reviewed actual-activity layer is required');
  const output = Buffer.from(transformSource(input.toString('utf8')));
  const checked = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: output, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (checked.error) throw checked.error;
  if (checked.status !== 0) throw Error(`Patched JavaScript failed syntax validation: ${checked.stderr.trim()}`);
  return { output, report: { homeyVersion: '13.5.3', originalSha256: sha256(input), patchedSha256: sha256(output), replacements: 1, driverId: DRIVER_ID } };
}
function writePatchedBundle(inputPath, outputPath) {
  if (!inputPath || !outputPath || path.resolve(inputPath) === path.resolve(outputPath)) throw Error('Expected separate input and output paths');
  if (fs.existsSync(outputPath)) throw Error('Output already exists');
  const { output, report } = patchBundle(fs.readFileSync(inputPath));
  fs.writeFileSync(outputPath, output, { flag: 'wx', mode: 0o644 });
  return report;
}

// These appearance fixtures use the exact helper and CSS in the new renderer.
const fixtureJsx = (type, props) => ({ type, props });
const renderActivity = new Function('L', SMOOTH_RENDERER_SOURCE + ';return LennoxThermostatActivity1353;')({ jsx: fixtureJsx, jsxs: fixtureJsx });
function activityFixtureSvg(props) {
  const markup = activity.activityFixtureSvg(props);
  return markup === '' ? '' : replaceOnce(markup, activity.ACTIVITY_CSS, SMOOTH_CSS);
}
if (require.main === module) {
  try {
    if (process.argv.length !== 4) throw Error('Usage: node patch-homey-13.5.3-activity-motion.cjs ACTIVITY_PATCHED.js OUTPUT.js');
    process.stdout.write(JSON.stringify(writePatchedBundle(process.argv[2], process.argv[3]), null, 2) + '\n');
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
module.exports = { EXPECTED_SHA256, DRIVER_ID, BEFORE, AFTER, SMOOTH_CSS, SMOOTH_RENDERER_SOURCE, renderActivity, activityFixtureSvg, transformSource, patchBundle, writePatchedBundle };
