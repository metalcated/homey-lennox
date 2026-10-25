#!/usr/bin/env node
'use strict';

// Optional read-only current-temperature view for one reviewed Lennox web layer.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const motion = require('./patch-homey-13.5.3-activity-motion.cjs');
const EXPECTED_SHA256 = '36b6457bdb22bb9629e9395333db98964ec590160cebf5e61c4c34c459684640';
const DRIVER_ID = motion.DRIVER_ID;
const BEFORE = motion.AFTER;
const OFF_RENDERER_SOURCE = `function LennoxOffTemperature1353(props={}){
  const available=props.online===true&&Number.isFinite(props.value);
  const decimals=Number.isInteger(props.decimals)&&props.decimals>=0&&props.decimals<=2?props.decimals:1;
  const value=available?props.value.toFixed(decimals):'—';
  const units=typeof props.units==='string'?props.units:'';
  const mode=props.mode==='off'?'Off':'Current temperature';
  const label='Current temperature '+(available?value+(units?' '+units:''):'unavailable')+(props.mode==='off'?'; thermostat Off':'');
  return(0,L.jsxs)('svg',{
    xmlns:'http://www.w3.org/2000/svg',viewBox:'-200 -200 400 400',role:'img','aria-label':label,
    'data-lennox-off-temperature':true,focusable:'false',style:{pointerEvents:'none'},
    children:[
      (0,L.jsx)('circle',{cx:0,cy:0,r:140,fill:'rgba(0,0,0,0.08)',stroke:'rgba(255,255,255,0.38)',strokeWidth:2}),
      (0,L.jsx)('text',{x:0,y:0,fill:'white',dominantBaseline:'middle',textAnchor:'middle',fontSize:68,style:{fontFamily:'inherit'},children:available?value+'°':value}),
      (0,L.jsx)('text',{x:0,y:42,fill:'rgba(255,255,255,0.72)',dominantBaseline:'middle',textAnchor:'middle',fontSize:16,style:{fontFamily:'inherit'},children:mode})
    ]
  });
}`;
function replaceOnce(source, before, after) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw Error(`Expected one reviewed off-temperature fragment; found ${count}`);
  return source.replace(before, after);
}
function buildRenderer() {
  const modeHook = "const [mainMode]=pR({deviceId:e.deviceId,capabilityId:lennoxDevice?'thermostat_mode':null});";
  const modeAndMeasurement = modeHook + `
const [lennoxOffTemperature,,lennoxOffMeasurement]=pR({deviceId:e.deviceId,capabilityId:lennoxDevice?'measure_temperature':null});
const lennoxTemperatureReadOnly=lennoxDevice&&(mainMode==='off'||(o==null&&e.component.capabilities.includes('measure_temperature')));
(0,P.useEffect)(()=>{if(lennoxTemperatureReadOnly)bz(zbe('off'));},[lennoxTemperatureReadOnly]);`;
  let source = replaceOnce(BEFORE, modeHook, modeAndMeasurement);
  source = replaceOnce(source, 'const canWriteAbsolute=lennoxDevice&&o!=null', 'const canWriteAbsolute=lennoxDevice&&!lennoxTemperatureReadOnly&&o!=null');
  source = replaceOnce(source, 'const action=showAdjustments?', `const action=lennoxTemperatureReadOnly?(0,L.jsx)(dR,{children:(0,L.jsxs)(LennoxThermostatDial1353,{style:{maxHeight:'100%'},children:[LennoxOffTemperature1353({online:t?.available===true&&t?.ready!==false&&t?.ready!==null,value:lennoxOffTemperature,decimals:lennoxOffMeasurement?.decimals,units:lennoxOffMeasurement?.units,mode:mainMode}),lennoxActivityOverlay]})}):showAdjustments?`);
  source = replaceOnce(source, 'children:n.length>1&&', 'children:!lennoxTemperatureReadOnly&&n.length>1&&');
  return OFF_RENDERER_SOURCE + '\n' + source;
}
const AFTER = buildRenderer();
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
function transformSource(source) {
  if (typeof source !== 'string') throw Error('Expected JavaScript source text');
  return replaceOnce(source, BEFORE, AFTER);
}
function patchBundle(input) {
  if (!Buffer.isBuffer(input) || sha256(input) !== EXPECTED_SHA256) throw Error('Unsupported Homey bundle; the exact reviewed activity-motion layer is required');
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
const fixtureJsx = (type, props) => ({ type, props });
const renderOffTemperature = new Function('L', OFF_RENDERER_SOURCE + ';return LennoxOffTemperature1353;')({ jsx: fixtureJsx, jsxs: fixtureJsx });
function escapeXml(value) { return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function fixtureMarkup(node) {
  if (node == null || node === false) return '';
  if (Array.isArray(node)) return node.map(fixtureMarkup).join('');
  if (typeof node !== 'object') return escapeXml(node);
  const { children, style, ...props } = node.props;
  const cssName = key => key.replace(/[A-Z]/g, char => '-' + char.toLowerCase());
  const attributes = Object.entries(props).map(([key, value]) => {
    const name = ['strokeWidth', 'fontSize', 'dominantBaseline', 'textAnchor'].includes(key) ? cssName(key) : key;
    return ` ${name}="${escapeXml(value)}"`;
  });
  if (style) attributes.push(` style="${escapeXml(Object.entries(style).map(([key, value]) => cssName(key) + ':' + value).join(';'))}"`);
  return `<${node.type}${attributes.join('')}>${fixtureMarkup(children)}</${node.type}>`;
}
function offTemperatureFixtureSvg(props) { return fixtureMarkup(renderOffTemperature(props)); }
if (require.main === module) {
  try {
    if (process.argv.length !== 4) throw Error('Usage: node patch-homey-13.5.3-off-temperature.cjs MOTION_PATCHED.js OUTPUT.js');
    process.stdout.write(JSON.stringify(writePatchedBundle(process.argv[2], process.argv[3]), null, 2) + '\n');
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
module.exports = { EXPECTED_SHA256, DRIVER_ID, BEFORE, AFTER, OFF_RENDERER_SOURCE, renderOffTemperature, offTemperatureFixtureSvg, transformSource, patchBundle, writePatchedBundle };
