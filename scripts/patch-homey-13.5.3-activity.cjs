#!/usr/bin/env node
'use strict';

// Optional presentation layer for one reviewed Homey Self-Hosted web build.
// It reads actual activity capabilities and never writes a device capability.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { PREVIEW_AFTER } = require('./patch-homey-13.5.3-thermostat-buttons.cjs');
const EXPECTED_SHA256 = '2ae2e73045b156d4df8d7f19283abaf96339127029251b6f1b162236b2963ed1';
const DRIVER_ID = 'homey:app:com.metalcated.lennox:thermostat';
const BEFORE = PREVIEW_AFTER;
const ACTIVITY_CSS = `
.lennoxActivityWave1353>path{animation:lennoxActivityWaveFlow1353 1.8s ease-in-out infinite}
.lennoxActivityWave1353>path:nth-child(2){animation-delay:-.3s}
.lennoxActivityWave1353>path:nth-child(3){animation-delay:-.6s}
.lennoxActivityWave1353[data-direction="cooling"]>path{animation-direction:reverse}
.lennoxActivityRotor1353{transform-box:view-box;transform-origin:50% 50%;animation:lennoxActivitySpin1353 1.2s linear infinite}
@keyframes lennoxActivityWaveFlow1353{0%{transform:translateY(3px);opacity:.45}35%{opacity:1}100%{transform:translateY(-3px);opacity:.45}}
@keyframes lennoxActivitySpin1353{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.lennoxActivityWave1353>path,.lennoxActivityRotor1353{animation:none!important}}
`.trim();
const ACTIVITY_RENDERER_SOURCE = `function LennoxThermostatActivity1353(props={}){
  if(props.online!==true)return null;
  const wave=props.activity==='heating'?'heating':props.activity==='cooling'?'cooling':null;
  const fan=props.fanRunning===true;
  const activity=wave??(fan?'fan':null);
  if(activity==null)return null;
  const label=wave==='heating'?'Heating is running':wave==='cooling'?'Cooling is running':'Fan is running';
  const color=wave==='heating'?'#ff453a':wave==='cooling'?'#40c8ff':'#e8edf3';
  const glyph=wave?(0,L.jsx)('g',{
    transform:'translate(0 -83)','data-activity-wave':wave,'aria-hidden':true,
    children:(0,L.jsxs)('g',{className:'lennoxActivityWave1353','data-direction':wave,fill:'none',stroke:color,strokeWidth:4.2,strokeLinecap:'round',strokeLinejoin:'round',children:[
      (0,L.jsx)('path',{d:'M -15 16 C -25 8 -5 -8 -15 -16'}),
      (0,L.jsx)('path',{d:'M 0 16 C -10 8 10 -8 0 -16'}),
      (0,L.jsx)('path',{d:'M 15 16 C 5 8 25 -8 15 -16'})
    ]})
  }):(0,L.jsx)('svg',{
    x:-24,y:-107,width:48,height:48,viewBox:'0 0 48 48','data-activity-fan':true,'aria-hidden':true,
    children:(0,L.jsx)('g',{className:'lennoxActivityRotor1353',fill:color,children:(0,L.jsxs)('g',{transform:'translate(24 24)',children:[
      (0,L.jsx)('path',{d:'M -2 -3 C -12 -8 -13 -19 -4 -19 C 5 -19 7 -9 3 -2 Z'}),
      (0,L.jsx)('path',{transform:'rotate(120)',d:'M -2 -3 C -12 -8 -13 -19 -4 -19 C 5 -19 7 -9 3 -2 Z'}),
      (0,L.jsx)('path',{transform:'rotate(240)',d:'M -2 -3 C -12 -8 -13 -19 -4 -19 C 5 -19 7 -9 3 -2 Z'}),
      (0,L.jsx)('circle',{cx:0,cy:0,r:3.5})
    ]})})
  });
  return(0,L.jsxs)('svg',{
    xmlns:'http://www.w3.org/2000/svg',viewBox:'-200 -200 400 400',preserveAspectRatio:'xMidYMid meet',
    role:'img','aria-label':label,focusable:'false','data-lennox-activity':activity,'data-fan-running':fan,
    style:{position:'absolute',inset:0,width:'100%',height:'100%',pointerEvents:'none',filter:'drop-shadow(0 1px 2px rgba(0,0,0,0.55))'},
    children:[(0,L.jsx)('style',{children:${JSON.stringify(ACTIVITY_CSS)}}),glyph]
  });
}`;

function replaceOnce(source, before, after) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw Error(`Expected one reviewed activity fragment; found ${count}`);
  return source.replace(before, after);
}
function activityRenderer() {
  let source = replaceOnce(BEFORE, 'min-width:0;min-height:0;width:100%;aspect-ratio:1;', 'position:relative;min-width:0;min-height:0;width:100%;aspect-ratio:1;');
  const scope = "const lennoxDevice=t?.driverId==='homey:app:com.metalcated.lennox:thermostat';";
  const hooks = `${scope}\nconst [lennoxHvacActivity]=pR({deviceId:e.deviceId,capabilityId:lennoxDevice?'hvac_state':null});\nconst [lennoxFanRunning]=pR({deviceId:e.deviceId,capabilityId:lennoxDevice?'fan_running':null});\nconst lennoxActivityOverlay=LennoxThermostatActivity1353({online:lennoxDevice&&t?.available===true&&t?.ready!==false&&t?.ready!==null,activity:lennoxHvacActivity,fanRunning:lennoxFanRunning});`;
  source = replaceOnce(source, scope, hooks);
  source = replaceOnce(source, '(0,L.jsx)(LennoxThermostatDial1353,{children:radial})', '(0,L.jsxs)(LennoxThermostatDial1353,{children:[radial,lennoxActivityOverlay]})');
  source = replaceOnce(source, ']}):(0,L.jsx)(dR,{children:radial});', ']}):(0,L.jsx)(dR,{children:lennoxDevice?(0,L.jsxs)(LennoxThermostatDial1353,{style:{maxHeight:"100%"},children:[radial,lennoxActivityOverlay]}):radial});');
  return ACTIVITY_RENDERER_SOURCE + '\n' + source;
}
const AFTER = activityRenderer();
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
function transformSource(source) {
  if (typeof source !== 'string') throw Error('Expected JavaScript source text');
  return replaceOnce(source, BEFORE, AFTER);
}
function patchBundle(input) {
  if (!Buffer.isBuffer(input) || sha256(input) !== EXPECTED_SHA256) throw Error('Unsupported Homey bundle; the exact reviewed immediate-preview layer is required');
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

// The appearance fixture runs the exact same helper as the patched renderer.
// Its inputs describe state only; neither helper connects to a Homey or device.
const fixtureJsx = (type, props) => ({ type, props });
const renderActivity = new Function('L', ACTIVITY_RENDERER_SOURCE + ';return LennoxThermostatActivity1353;')({ jsx: fixtureJsx, jsxs: fixtureJsx });
function escapeXml(value) { return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function fixtureMarkup(node) {
  if (node == null || node === false) return '';
  if (Array.isArray(node)) return node.map(fixtureMarkup).join('');
  if (typeof node !== 'object') return escapeXml(node);
  const { children, style, ...props } = node.props;
  const cssName = key => key.replace(/[A-Z]/g, char => '-' + char.toLowerCase());
  const attributes = Object.entries(props).map(([key, value]) => {
    const name = key === 'className' ? 'class' : ['strokeWidth', 'strokeLinecap', 'strokeLinejoin'].includes(key) ? cssName(key) : key;
    return ` ${name}="${escapeXml(value)}"`;
  });
  if (style) attributes.push(` style="${escapeXml(Object.entries(style).map(([key, value]) => cssName(key) + ':' + value).join(';'))}"`);
  // This static stylesheet is raw text inside an HTML SVG appearance fixture.
  const content = node.type === 'style' ? ACTIVITY_CSS : fixtureMarkup(children);
  return `<${node.type}${attributes.join('')}>${content}</${node.type}>`;
}
function activityFixtureSvg(props) { return fixtureMarkup(renderActivity(props)); }

if (require.main === module) {
  try {
    if (process.argv.length !== 4) throw Error('Usage: node patch-homey-13.5.3-activity.cjs PREVIEW_PATCHED.js OUTPUT.js');
    process.stdout.write(JSON.stringify(writePatchedBundle(process.argv[2], process.argv[3]), null, 2) + '\n');
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
module.exports = { EXPECTED_SHA256, DRIVER_ID, BEFORE, AFTER, ACTIVITY_CSS, ACTIVITY_RENDERER_SOURCE, renderActivity, activityFixtureSvg, transformSource, patchBundle, writePatchedBundle };
