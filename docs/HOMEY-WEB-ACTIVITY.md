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
