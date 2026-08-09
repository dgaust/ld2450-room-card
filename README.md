# LD2450 Room Card

A dependency-free Lovelace card that plots the live position of the targets
tracked by an **HLK-LD2450** (mmWave) radar onto a to-scale floor plan of the
room. No Lit, no CDN, no build step — one plain custom element.

![type:video](https://github.com/dgaust/ld2450-room-card) <!-- replace with a screenshot -->

- Draws the room as a fixed-aspect rectangle, so it never scales oddly.
- Places a coloured dot for each detected target (up to 3), with the target's
  distance printed on the dot.
- Discovers `target_N_x` / `target_N_y` / `target_N_distance` from the device
  automatically — no entity ids to wire up.
- While editing the card, overlays the sensor's **facing direction** and any
  configured **region-filter zones**, so you can place them by eye.
- Idle radar → an empty room. A transient error never sticks.

## Requirements

The [ESPHome LD2450 component](https://esphome.io/components/sensor/ld2450/)
exposing, per target, the `x`, `y` and (optionally) `distance` sensors, all in
**millimetres**. Any integration that produces `…target_N_x` / `…target_N_y`
sensor entities on one device works.

## Installation

### HACS (recommended)

1. HACS → ⋮ → **Custom repositories**.
2. Add `https://github.com/dgaust/ld2450-room-card`, category **Dashboard**.
3. Install **LD2450 Room Card**, then hard-refresh the browser.

HACS registers the dashboard resource for you. If you installed manually,
add the resource yourself:

```yaml
url: /hacsfiles/ld2450-room-card/ld2450-room-card.js
type: module
```

## Configuration

Add it from the card picker ("LD2450 Room Card") and use the visual editor, or
in YAML:

```yaml
type: custom:ld2450-room-card
device: <your mmWave device>   # required
name: Laundry
room_width: 3090               # mm, along the wall the sensor is mounted on
room_depth: 2120               # mm, straight out from the sensor
sensor_offset: 500             # mm, sensor's distance from the left edge
sensor_angle: 0                # degrees the sensor is tilted off the wall-normal
targets: 3                     # 1–3
flip_x: false                  # mirror left/right if the sign is reversed
show_distance: true            # print each target's distance on its dot
animate: true                  # slide dots to their new position
animation_ms: 500              # slide duration in milliseconds
fade_ms: 300                   # fade dots in/out as targets appear/vanish
```

| Option          | Default        | Description |
| --------------- | -------------- | ----------- |
| `device`        | —              | **Required.** The radar's device; the card discovers its target sensors. |
| `name`          | —              | Card title. Omit for no header. |
| `room_width`    | `3000`         | Room size (mm) **along** the wall the sensor is mounted on — the sensor's X axis. |
| `room_depth`    | `3000`         | Room size (mm) **out from** that wall — the sensor's Y axis. |
| `sensor_offset` | `room_width/2` | How far along the wall the sensor sits, from the left edge (mm). Centre it by leaving this out. |
| `sensor_angle`  | `0`            | Tilt of the sensor's boresight off the wall-normal, in degrees. `0` faces straight into the room; positive rotates toward the room's **right**. Each target is rotated by this angle so the plot matches the real position. |
| `targets`       | `3`            | How many targets to plot (1–3). |
| `flip_x`        | `false`        | Mirror the X axis. The LD2450's X sign depends on how the board is physically mounted — flip this if targets appear on the wrong side. |
| `show_distance` | `true`         | Show each target's distance on its dot. When off, dots are plain markers. |
| `animate`       | `true`         | Slide dots to each new position instead of snapping. A target that reappears jumps to its first spot rather than streaking across the card. |
| `animation_ms`  | `500`          | Slide duration in milliseconds. Roughly match your radar's update rate — shorter tracks more tightly, longer is smoother but lags. `0` disables (same as `animate: false`). |
| `fade_ms`       | `300`          | Fade-in/out duration in milliseconds as a target is detected or lost, so dots don't blink on and off. `0` disables the fade. |

### The coordinate frame

The LD2450 reports each target as **X** (lateral, mm, ±) and **Y** (distance
from the sensor, mm, ≥ 0), with the sensor itself at the origin. The card maps
that onto the room using `sensor_offset`: the mounting wall spans
`-sensor_offset` (left edge) to `room_width - sensor_offset` (right edge), and
depth runs `0 → room_depth`.

If someone standing by the **left** wall shows up on the **right** of the plan,
set `flip_x: true` (or vice-versa) — that's the only ambiguity, and it comes
from the sensor's physical orientation.

If the radar isn't mounted square to the wall, set `sensor_angle` to the tilt
of its boresight off the perpendicular. The card rotates every reported point
by that angle at the sensor pivot before placing it, so the plot lands in the
right room position. While you're **editing the card**, a short line on the
sensor marker shows the configured facing direction — tune the angle until it
points the way the radar really looks (and if the whole scene rotates the wrong
way, negate the angle). The line is hidden on the live dashboard.

### Region-filter zones

If the device exposes the LD2450's zone-coordinate number entities (the ESPHome
`number:` platform: `zone_N_x1` / `zone_N_y1` / `zone_N_x2` / `zone_N_y2`), the
card draws each configured zone as a dashed rectangle **while you're editing the
card**. A zone is rigidly attached to the sensor's face, so it **rotates with
`sensor_angle`** about the sensor and is anchored by `sensor_offset` — but it is
**not** mirrored by `flip_x` (that's a lateral-sign correction for reading the
dots, not a physical rotation of the sensor). Zones are coloured by the
`zone_type` select: red for `Filter`, blue for `Detection`, grey otherwise.
Unset or zero-area zones aren't drawn, and nothing zone-related shows on the
live dashboard. There's no configuration — the zones are read straight from the
device.

### Theming

Dot colours and the room fill fall back to sensible values but can be themed:

```yaml
ld2450-t1-color: "#e5484d"
ld2450-t2-color: "#4c6ef5"
ld2450-t3-color: "#2f9e44"
ld2450-room-fill: "var(--secondary-background-color)"
```

## License

[MIT](LICENSE)
