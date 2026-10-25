# Actual thermostat activity above the dial

This optional local presentation layer adds a compact animated activity glyph
above the native Lennox thermostat target in the reviewed Homey Self-Hosted
**13.5.3** web interface. The draggable dial, small precision buttons, immediate
preview and background command queue remain available. The installed app and
this web layer are separate: the app installer does not replace Homey assets.

## Reported activity and priority

The glyph reads the zone's `hvac_state` and hidden `fan_running` capabilities
through Homey's existing capability subscriptions. It does not infer actual
activity from the selected dial, requested temperature, thermostat mode or fan
mode.

| Reported state while online | Glyph |
| --- | --- |
| `hvac_state: heating` | Three animated red waves (`#ff453a`) |
| `hvac_state: cooling` | Three animated blue waves (`#40c8ff`) |
| Any other HVAC state and `fan_running: true` | A rotating neutral three-blade fan |
| Any other HVAC state without an actual true fan reading | None |
| Device unavailable or explicitly not ready | None |

Heating or cooling takes visual precedence over a simultaneous blower reading.
Idle, unknown and defrost states never produce heating or cooling waves. They
can show the fan only when its actual boolean reading is true. A fan-mode
setting such as On or Circulate is not evidence that the blower is running.

The accessible label identifies the actual displayed activity: “Heating is
running”, “Cooling is running” or “Fan is running”. The SVG does not introduce
visible status text. Its actual activity is independent of the editable target
and remains visible in read-only mode. In Automatic, switching between the
heating and cooling dials does not change the reported operating activity.

Homey's existing background gradient still represents temperature demand from
its native dial. The new glyph represents actual reported activity, so the two
can differ while the thermostat starts, stops or transitions.

## Layout and motion

The overlay shares the native SVG's `-200 -200 400 400` view box. Its compact
icon is centered at `(0, -83)`, above the central target text. A relative wrapper
and an absolute overlay preserve the native SVG's aspect ratio and alignment;
no row is added to the control pane. The SVG uses `pointer-events: none`, so it
cannot intercept dial dragging or precision-button presses.

The layer does not change Homey's radial renderer. It wraps an existing Lennox
radial even when precision buttons are absent, but does not fabricate a target
or a new control when Homey has no thermostat control to render. Other drivers
keep their existing native control tree.

The waves are solid curves with staggered gentle motion and opacity; cooling
reverses their direction. The fan rotates around its own centered three-blade
hub. All animation rules have Lennox-specific names. The
`prefers-reduced-motion: reduce` media query freezes the waves and fan while
keeping the activity glyph visible. This affects the Homey web interface only;
the native Homey mobile application's renderer is unchanged.

## Review and generation

The generator is
[`scripts/patch-homey-13.5.3-activity.cjs`](../scripts/patch-homey-13.5.3-activity.cjs).
It accepts only the exact immediate-preview bundle with SHA-256:

```text
2ae2e73045b156d4df8d7f19283abaf96339127029251b6f1b162236b2963ed1
```

```sh
node scripts/patch-homey-13.5.3-activity.cjs \
  /absolute/path/controls-preview.js \
  /absolute/path/controls-activity.js
```

The generator replaces exactly one reviewed renderer, validates the complete
output as JavaScript ESM, and reports both checksums. It rejects unexpected
inputs, missing or duplicate fragments, repeated application, an existing
output and a matching input/output path. It never deploys a generated file.
The reviewed activity output has SHA-256:

```text
fde675312b7b0009e57b10ee75de531524a7f25ef1200efe4faf54bf2c83dd3a
```

Earlier patch generators, artifacts and rollback boundaries remain unchanged.
The scope is the exact driver
`homey:app:com.metalcated.lennox:thermostat`.

`renderActivity({ online, activity, fanRunning })` returns the exact helper's
fixture node tree. `activityFixtureSvg()` accepts the same inputs and returns an
SVG for isolated appearance checks. Both use the same renderer and CSS as the
patched web component, and neither connects to Homey or a physical thermostat.

## Validation and operational boundary

The focused renderer suite passes 7 tests covering actual capability events,
heating/cooling/fan priority, read-only and missing-button controls, unavailable
and invalid readings, stable hook order, reduced-motion rules, and zero command
writes. The reviewed-bundle check verifies complete JavaScript syntax, unchanged
native radial code, and exact reversal to the input above. Browser appearance
fixtures show a centered fan and clear red/blue waves above the target without
overlap. These fixtures do not change thermostat state; deployed acceptance is
separate.

The new layer requires the matching app implementation that exposes the actual
hidden `fan_running` reading. An older app without that capability can still
show its reported heating/cooling activity, but must not substitute fan mode for
the missing fan measurement.

Deploy only with the separately reviewed, checksum-pinned local asset manager.
Preserve its original backup and metadata, replace the asset atomically, verify
both file and decoded HTTP checksums, and verify that the Homey container has
not restarted. Rollback restores the exact immediate-preview bundle above.
The activity layer must be rolled back before an earlier layer is removed.
An unknown vendor build or Homey update requires another source review; do not
apply this version-specific transformation automatically.

## Applied deployment and rollback

The matching app is **0.1.8**. The root-owned activity backup, replacement and metadata are in `/opt/docker/homey/local-patches/thermostat-activity-13.5.3`. The separately pinned [activity manager](../scripts/manage-homey-web-activity.py) reuses the unchanged deployment guards.

Rollback restores all previous dial controls and preview behavior:

```sh
ssh -T foreman.gnet.com 'sudo -n ssh -T iot-mgmt python3 /opt/docker/homey/local-patches/thermostat-activity-13.5.3/manage-homey-web-activity.py rollback'
```

Reapply the staged reviewed bundle:

```sh
ssh -T foreman.gnet.com 'sudo -n ssh -T iot-mgmt python3 /opt/docker/homey/local-patches/thermostat-activity-13.5.3/manage-homey-web-activity.py apply --patched-file /opt/docker/homey/local-patches/thermostat-activity-13.5.3/index-LWSkNFnB.js.patched --patched-sha256 fde675312b7b0009e57b10ee75de531524a7f25ef1200efe4faf54bf2c83dd3a'
```

The live apply/rollback/reapply cycle matched file and HTTP checksums without restarting the Homey server. Both Node 22 and Node 24 passed all 241 tests with the reviewed vendor fixture. Installation preserved the existing device and Flow definitions. The current live telemetry has been verified independently from the appearance fixture; no physical thermostat command was issued to force an animation.


## Smoother activity motion layer

The optional follow-up generator,
[`scripts/patch-homey-13.5.3-activity-motion.cjs`](../scripts/patch-homey-13.5.3-activity-motion.cjs),
changes only the activity stylesheet. The original activity generator and its
checksums remain unchanged.

Each solid wave travels linearly from `+4px` to `-4px` over 2.4 seconds. Its
opacity reaches zero at both ends, hiding the loop reset, and stays fully
visible through the middle half of the cycle. The second and third waves are
staggered by `-0.4s` and `-0.8s`. Cooling keeps the reversed direction. The
centered fan rotates linearly once per 2.4 seconds. Scoped `will-change` hints
are removed under reduced motion, which freezes a visible static glyph.

The actual-state subscriptions, glyph priority, read-only behavior, geometry,
accessible labels and pointer handling are unchanged. This layer does not
change the native dial, immediate target preview, command queue, capability
writer, installed app or physical thermostat configuration.

The generator accepts only the previous activity output:

```text
fde675312b7b0009e57b10ee75de531524a7f25ef1200efe4faf54bf2c83dd3a
```

Its reviewed output has SHA-256:

```text
36b6457bdb22bb9629e9395333db98964ec590160cebf5e61c4c34c459684640
```

```sh
node scripts/patch-homey-13.5.3-activity-motion.cjs \
  /absolute/path/controls-activity.js \
  /absolute/path/controls-activity-motion.js
```

It requires exactly one previously reviewed renderer, checks the complete
output as JavaScript ESM, and refuses existing output files, repeated
application and unsupported input checksums. `renderActivity()` and
`activityFixtureSvg()` expose the exact revised helper and CSS for isolated
appearance checks without device commands.

Deployment is a separate, checksum-guarded operation. Its rollback restores the
previous activity bundle `fde675…`, retaining the original activity glyphs and
all dial controls. Roll back this follow-up before removing the original
activity layer; never overwrite either layer's backup or metadata.

The deployed motion layer is managed separately in `/opt/docker/homey/local-patches/thermostat-motion-13.5.3`. Roll it back before rolling back the original activity layer:

```sh
ssh -T foreman.gnet.com 'sudo -n ssh -T iot-mgmt python3 /opt/docker/homey/local-patches/thermostat-motion-13.5.3/manage-homey-web-motion.py rollback'
```

Reapply its reviewed staged asset:

```sh
ssh -T foreman.gnet.com 'sudo -n ssh -T iot-mgmt python3 /opt/docker/homey/local-patches/thermostat-motion-13.5.3/manage-homey-web-motion.py apply --patched-file /opt/docker/homey/local-patches/thermostat-motion-13.5.3/index-LWSkNFnB.js.patched --patched-sha256 36b6457bdb22bb9629e9395333db98964ec590160cebf5e61c4c34c459684640'
```

The live motion-layer apply/rollback/reapply passed exact file and decoded HTTP checks without a server restart. Both supported Node runtimes passed all 248 tests. This presentation change does not reinstall or version-bump app 0.1.8.


## Current temperature while Off

The optional
[`scripts/patch-homey-13.5.3-off-temperature.cjs`](../scripts/patch-homey-13.5.3-off-temperature.cjs)
adds a read-only current-temperature view when the Lennox thermostat is Off.
The matching app **0.1.9** exposes its existing base `measure_temperature` as a
thermostat component while Off and restores its sensor presentation in known
active modes. No capability ID, history or Flow reference is replaced.

The reviewed Homey renderer normally centers the target and always attaches a
drag handle, even to a measurement-only component. The new Off view instead
centers the actual base measurement in a neutral circle and labels it “Off”.
It ignores any retained target, including a single-setpoint thermostat's base
target. There is no drag handle, precision button, target selector or writable
temperature callback in this view. The actual fan/activity overlay remains
available without changing its smooth animation or telemetry semantics.

The base measurement uses Homey's actual converted units and decimals. Missing,
invalid or unavailable readings display an em dash instead of zero or an old
target. During incomplete metadata, an exact Lennox component containing the
base measurement without a selected target stays read-only and is labelled
“Current temperature”; it does not falsely claim the thermostat is Off.

All capability subscriptions and queue hooks remain unconditional. The existing
mode-change context cancels unsent temperature batches. A retained callback from
an earlier active dial also cannot enqueue a write while the current view is
read-only, including single-setpoint systems with a preserved target. Known active modes
return to the previous native dial, precision buttons and preview behavior.
The reviewed native radial renderer and capability writer remain unchanged.
Other vendors' thermostat views are outside this layer's scope.

This generator accepts only the smooth-motion bundle:

```text
36b6457bdb22bb9629e9395333db98964ec590160cebf5e61c4c34c459684640
```

Its reviewed output has SHA-256:

```text
c9677f4eb4923de3963459b3d23f95cfb987c98c78678c468da2cdb37d29e47d
```

```sh
node scripts/patch-homey-13.5.3-off-temperature.cjs \
  /absolute/path/controls-activity-motion.js \
  /absolute/path/controls-off-temperature.js
```

The generator replaces one reviewed renderer, validates complete JavaScript ESM
syntax, and refuses unsupported inputs, duplicate fragments, repeated
application and existing output files. `renderOffTemperature()` and
`offTemperatureFixtureSvg()` accept `{ online, value, decimals, units, mode }`
for isolated appearance checks without connecting to Homey or the thermostat.

Deployment and rollback use
[`scripts/manage-homey-web-off-temperature.py`](../scripts/manage-homey-web-off-temperature.py)
with the unchanged deployment guards. The host directory is
`/opt/docker/homey/local-patches/thermostat-off-temperature-13.5.3`.
For an independent asset rollback, run on `iot-mgmt`:

```sh
sudo python3 /opt/docker/homey/local-patches/thermostat-off-temperature-13.5.3/manage-homey-web-off-temperature.py rollback
```

This restores the exact smooth-motion web asset above. It does not undo app
0.1.9's capability metadata: the measurement-only component remains while Off,
so the previous native renderer can show a target placeholder and smaller
current reading. A retained single-setpoint target can also be grouped by
Homey's native prepass. Reinstalling an older app alone does not explicitly
reset the persisted measurement option; do not treat it as a complete UI
rollback. Device history and Flow references remain intact. Keep every earlier
layer's backup and metadata; roll back this asset layer before the motion or
activity layers.


The Off-temperature layer was validated with all 261 tests on Node 22 and Node 24,
including the captured Homey grouping method and reviewed web bundle. Version
0.1.9 was installed in place. Apply, exact rollback and reapply all matched the
file and served checksums without a Homey server restart. The actual browser
showed 72°F and an Off label in the neutral dial, with no target, handle or
precision buttons; closing and reopening preserved it. An actual running-fan
report still displayed the fan overlay. Physical mode transitions were not
forced, and native mobile rendering remains unverified.
