/*
 * LD2450 Room Card — a dependency-free Lovelace card that plots the live
 * position of the targets tracked by an HLK-LD2450 (mmWave) radar onto a
 * to-scale floor plan of the room.
 *
 * No build step, no Lit, no CDN: one plain custom element. Point it at the
 * radar's device and tell it the room size and where the sensor sits; it
 * discovers the target_N_x / target_N_y / target_N_distance sensors itself,
 * so nothing hard-codes an entity id.
 *
 * Coordinate frame (matches the LD2450): the sensor is the origin, X is
 * lateral (mm, +/-), Y is distance straight out from the wall it is mounted
 * on (mm, always >= 0). `sensor_offset` is how far along the mounting wall
 * the sensor sits, so the wall spans -sensor_offset .. room_width-offset.
 *
 * `sensor_angle` (degrees) handles a radar that isn't mounted square to the
 * wall: it is the tilt of the boresight away from the wall-normal (0 = facing
 * straight into the room, positive = rotated toward the room's right). Each
 * reported (x, y) is rotated by that angle at the sensor pivot before it is
 * placed, so the plotted position matches where the person actually is.
 */

const CARD_VERSION = "1.1.0";

/* Plain text, not a %c banner: console styling only takes literal colours
 * and nothing here should hardcode one. */
console.info(`LD2450-ROOM-CARD ${CARD_VERSION}`);

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const isBad = (s) => !s || s.state === "unknown" || s.state === "unavailable";

function num(hass, entityId) {
  const st = hass && entityId ? hass.states[entityId] : null;
  if (isBad(st)) return null;
  const v = parseFloat(st.state);
  return Number.isFinite(v) ? v : null;
}

function unitOf(hass, entityId) {
  const st = hass && entityId ? hass.states[entityId] : null;
  /* attributes is normally {} but can be null on a half-formed state after a
   * restart; a bare `.unit_of_measurement` there would throw. */
  return (st && st.attributes && st.attributes.unit_of_measurement) || "";
}

/*
 * Discover the radar's per-target coordinate sensors and the presence
 * binary_sensor from the frontend entity registry (hass.entities), matched
 * by id suffix so the ESPHome name prefix is irrelevant. Registry-based, so
 * it reflects which entities *exist*, not whether a target is currently seen
 * — an idle radar still discovers cleanly and simply shows no dots.
 */
function discover(hass, deviceId) {
  const out = { targets: [], presence: null };
  if (!hass || !deviceId || !hass.entities) return out;

  const devEnts = Object.keys(hass.entities).filter(
    (e) => hass.entities[e].device_id === deviceId && hass.states[e]
  );
  const find = (suffix) => devEnts.find((e) => e.endsWith(suffix)) || null;

  for (let n = 1; n <= 3; n++) {
    const x = find(`target_${n}_x`);
    const y = find(`target_${n}_y`);
    if (!x || !y) continue;
    out.targets.push({ x, y, distance: find(`target_${n}_distance`) });
  }
  out.presence =
    devEnts.find((e) => e.startsWith("binary_sensor.") && /presence/.test(e)) ||
    null;
  return out;
}

/* Short label for a dot: metres to 2dp when the distance sensor reports mm,
 * otherwise the raw value + unit. Falls back to the hypotenuse of x/y when
 * the radar exposes no distance sensor. */
function distanceLabel(hass, target) {
  let v = num(hass, target.distance);
  let unit = unitOf(hass, target.distance);
  if (v === null) {
    const x = num(hass, target.x);
    const y = num(hass, target.y);
    if (x === null || y === null) return "";
    v = Math.hypot(x, y);
    unit = "mm";
  }
  if (unit === "mm") return `${(v / 1000).toFixed(2)} m`;
  return `${v}${unit ? " " + unit : ""}`;
}

const BASE_CSS = `
  ha-card { padding: 12px 14px 14px; }
  .head { display:flex; align-items:center; gap:8px; margin:0 0 10px; }
  .title { font-size:1.05rem; font-weight:500; color:var(--primary-text-color); }
  .pill-present {
    margin-left:auto; font-size:.72rem; padding:2px 8px; border-radius:10px;
    background:var(--secondary-background-color); color:var(--secondary-text-color);
  }
  .pill-present.on { color:var(--primary-text-color); }
  .room { position:relative; width:100%; }
  .plan { width:100%; height:auto; display:block; }
  .dot {
    position:absolute; transform:translate(-50%,-50%);
    display:none; align-items:center; justify-content:center;
    box-sizing:border-box; pointer-events:none;
    background:var(--c); color:#fff;
    font-size:11px; font-weight:500; line-height:1;
    box-shadow:0 1px 3px rgba(0,0,0,.35);
  }
  .dot.on { display:inline-flex; }
  .dot.pill { min-width:14px; height:20px; padding:0 7px; border-radius:11px; }
  .dot.bare { width:14px; height:14px; padding:0; border-radius:50%; }
  .dot.bare .lbl { display:none; }
  .t1 { --c: var(--ld2450-t1-color, #e5484d); }
  .t2 { --c: var(--ld2450-t2-color, #4c6ef5); }
  .t3 { --c: var(--ld2450-t3-color, #2f9e44); }
  .warn {
    display:flex; align-items:center; gap:8px; padding:10px 4px;
    color:var(--secondary-text-color); font-size:.9rem;
  }
`;

/* ------------------------------------------------------------------ *
 * Card
 * ------------------------------------------------------------------ */

class Ld2450RoomCard extends HTMLElement {
  setConfig(config) {
    if (!config || !config.device) {
      throw new Error("Select the mmWave device in the card editor.");
    }
    /* Normalise once, so render code can trust plain numbers. */
    const width = Number(config.room_width) || 3000;
    const depth = Number(config.room_depth) || 3000;
    this._config = {
      ...config,
      room_width: width,
      room_depth: depth,
      sensor_offset:
        config.sensor_offset != null ? Number(config.sensor_offset) : width / 2,
      sensor_angle: Number(config.sensor_angle) || 0,
      targets: Math.min(3, Math.max(1, Number(config.targets) || 3)),
      flip_x: !!config.flip_x,
      show_distance: config.show_distance !== false,
    };
    /* Force a rebuild and drop any stale DOM so the next hass renders fresh. */
    this._sig = null;
    if (this.shadowRoot) this.shadowRoot.innerHTML = "";
  }

  set hass(hass) {
    this._hass = hass;
    if (!hass || !this._config) return;

    /*
     * A render must never leave the card wedged. HA re-supplies `hass` on
     * every state change; if one pass throws — a half-formed state after a
     * restart, a registry not finished loading — the exception would break
     * the card, and worse, a cached signature could describe a DOM that was
     * never finished so later good updates skip the rebuild and the broken
     * render sticks. Catch it, show a card that says so, and null the
     * signature so the very next update rebuilds from scratch.
     */
    try {
      const ids = discover(hass, this._config.device);
      this._ids = ids;

      /* No coordinate sensors on this device is almost always the wrong
       * device, not an idle radar — say so, and rebuild if a later update
       * (registry finished loading) does find them. */
      if (ids.targets.length === 0) {
        this._renderEmpty();
        this._sig = null;
        return;
      }

      const n = Math.min(this._config.targets, ids.targets.length);
      const sig = JSON.stringify([
        this._config.device,
        this._config.name,
        this._config.room_width,
        this._config.room_depth,
        this._config.sensor_offset,
        this._config.sensor_angle,
        this._config.flip_x,
        this._config.show_distance,
        n,
      ]);
      if (sig !== this._sig) {
        this._build(n);
        this._sig = sig;
      }
      this._update(n);
    } catch (err) {
      this._renderError(err);
    }
  }

  _shadow() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    return this.shadowRoot;
  }

  _build(n) {
    const c = this._config;
    const W = c.room_width;
    const D = c.room_depth;
    const off = c.sensor_offset;
    /* Margin in the same mm units as the room, so the outline stroke and the
     * sensor marker have room to sit without being clipped at the viewBox
     * edge. Kept proportional so it scales with any room size. */
    const M = Math.round(Math.max(W, D) * 0.06) || 60;
    const vbW = W + 2 * M;
    const vbH = D + 2 * M;
    const sx = M + off; // sensor position along the top wall, in viewBox units
    const stroke = Math.max(4, Math.round(M * 0.14));
    const rx = Math.round(Math.min(W, D) * 0.03);
    const fontSize = Math.round(vbW * 0.032);

    /* Boresight indicator: a short line from the sensor showing which way it
     * actually looks. Straight down the room at angle 0, tilting toward +X as
     * the angle grows — the same rotation the coordinates get, so a target
     * dead-ahead of the radar lands on this line. */
    const a = (c.sensor_angle * Math.PI) / 180;
    const bl = Math.round(Math.min(W, D) * 0.16);
    const bx = sx + bl * Math.sin(a);
    const by = M + bl * Math.cos(a);

    this._geo = { M, vbW, vbH, W, D, off };

    const dots = Array.from({ length: n })
      .map(
        (_, i) =>
          `<div class="dot t${i + 1} ${
            c.show_distance ? "pill" : "bare"
          }" data-i="${i}"><span class="lbl"></span></div>`
      )
      .join("");

    const title = c.name || "";
    const head = title
      ? `<div class="head"><span class="title">${title}</span>` +
        `<span class="pill-present" id="present">—</span></div>`
      : "";

    this._shadow().innerHTML = `
      <style>${BASE_CSS}</style>
      <ha-card>
        ${head}
        <div class="room">
          <svg class="plan" viewBox="0 0 ${vbW} ${vbH}"
               preserveAspectRatio="xMidYMid meet"
               xmlns="http://www.w3.org/2000/svg">
            <rect x="${M}" y="${M}" width="${W}" height="${D}" rx="${rx}"
              fill="var(--ld2450-room-fill, var(--secondary-background-color))"
              stroke="var(--divider-color)" stroke-width="${stroke}"/>
            <line x1="${sx}" y1="${M}" x2="${bx}" y2="${by}"
              stroke="var(--secondary-text-color)" stroke-width="${Math.max(2, Math.round(M * 0.08))}"
              stroke-linecap="round"/>
            <circle cx="${sx}" cy="${M}" r="${Math.round(M * 0.3)}"
              fill="var(--secondary-text-color)"/>
            <text x="${sx}" y="${M + fontSize * 1.5}" fill="var(--secondary-text-color)"
              font-size="${fontSize}" text-anchor="middle"
              font-family="var(--paper-font-body1_-_font-family, sans-serif)">sensor</text>
          </svg>
          ${dots}
        </div>
      </ha-card>`;

    this._present = this._shadow().getElementById("present");
    this._dots = Array.from(this._shadow().querySelectorAll(".dot"));
  }

  _update(n) {
    const hass = this._hass;
    const c = this._config;
    const g = this._geo;
    const ids = this._ids;

    for (let i = 0; i < n; i++) {
      const dot = this._dots[i];
      if (!dot) continue;
      const t = ids.targets[i];
      const x = num(hass, t.x);
      const y = num(hass, t.y);

      /* No lock on this target (idle radar reports unknown, or 0,0 for an
       * empty slot) — park the dot by hiding it. */
      if (x === null || y === null || (x === 0 && y === 0)) {
        dot.classList.remove("on");
        continue;
      }

      const ex = c.flip_x ? -x : x;
      /* Rotate the sensor-frame point into room axes when the radar is
       * mounted at an angle to the wall. Positive angle tilts the boresight
       * toward +X; the target's lateral position becomes rx, its depth ry. */
      const a = (c.sensor_angle * Math.PI) / 180;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const rx = ex * ca + y * sa;
      const ry = -ex * sa + y * ca;
      /* Clamp inside the walls so noise or an out-of-room reflection rides
       * the edge instead of flying off the card. */
      let px = g.M + Math.min(Math.max(rx + c.sensor_offset, 0), g.W);
      let py = g.M + Math.min(Math.max(ry, 0), g.D);

      dot.style.left = (px / g.vbW) * 100 + "%";
      dot.style.top = (py / g.vbH) * 100 + "%";
      if (c.show_distance) dot.querySelector(".lbl").textContent = distanceLabel(hass, t);
      dot.classList.add("on");
    }

    if (this._present) {
      const on = ids.presence && hass.states[ids.presence]
        ? hass.states[ids.presence].state === "on"
        : this._dots.some((d) => d.classList.contains("on"));
      this._present.textContent = on ? "occupied" : "clear";
      this._present.classList.toggle("on", on);
    }
  }

  /*
   * Replace the whole shadow DOM with an error card and null the signature,
   * so the next update runs _build() from scratch rather than patching a DOM
   * that isn't there. Without the reset a single transient failure would show
   * the error card forever — the bug this guard exists to prevent.
   */
  _renderError(err) {
    const msg = (err && err.message) || String(err);
    this._shadow().innerHTML = `
      <style>${BASE_CSS}</style>
      <ha-card>
        <div class="warn">
          <ha-icon icon="mdi:alert-circle-outline"></ha-icon>
          LD2450 room card error: ${msg}
        </div>
      </ha-card>`;
    console.error("ld2450-room-card:", err);
  }

  _renderEmpty() {
    this._shadow().innerHTML = `
      <style>${BASE_CSS}</style>
      <ha-card>
        <div class="warn">
          <ha-icon icon="mdi:radar"></ha-icon>
          No LD2450 target sensors found on this device. Pick the mmWave
          device in the card editor.
        </div>
      </ha-card>`;
  }

  getCardSize() {
    return 4;
  }

  static getStubConfig(hass) {
    let device = "";
    if (hass && hass.entities) {
      for (const [e, reg] of Object.entries(hass.entities)) {
        if (/target_1_x$/.test(e) && reg.device_id) {
          device = reg.device_id;
          break;
        }
      }
    }
    return {
      device,
      room_width: 3000,
      room_depth: 3000,
      targets: 3,
      show_distance: true,
    };
  }

  static getConfigElement() {
    return document.createElement("ld2450-room-card-editor");
  }
}

/* ------------------------------------------------------------------ *
 * Editor — ha-form is part of the HA frontend, so this stays dependency-free.
 * ------------------------------------------------------------------ */

const EDITOR_SCHEMA = [
  { name: "device", required: true, selector: { device: {} } },
  { name: "name", selector: { text: {} } },
  {
    name: "room_width",
    selector: { number: { min: 500, max: 10000, step: 10, unit_of_measurement: "mm", mode: "box" } },
  },
  {
    name: "room_depth",
    selector: { number: { min: 500, max: 10000, step: 10, unit_of_measurement: "mm", mode: "box" } },
  },
  {
    name: "sensor_offset",
    selector: { number: { min: 0, max: 10000, step: 10, unit_of_measurement: "mm", mode: "box" } },
  },
  {
    name: "sensor_angle",
    selector: { number: { min: -90, max: 90, step: 1, unit_of_measurement: "°", mode: "box" } },
  },
  { name: "targets", selector: { number: { min: 1, max: 3, step: 1, mode: "box" } } },
  { name: "flip_x", selector: { boolean: {} } },
  { name: "show_distance", selector: { boolean: {} } },
];

const EDITOR_LABELS = {
  device: "mmWave device",
  name: "Card title (optional)",
  room_width: "Room width (along sensor wall)",
  room_depth: "Room depth (out from sensor)",
  sensor_offset: "Sensor offset from left edge",
  sensor_angle: "Sensor angle off the wall (°)",
  targets: "Targets to plot (1–3)",
  flip_x: "Flip X (mirror left/right)",
  show_distance: "Show distance on each dot",
};

class Ld2450RoomCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass;
  }

  _render() {
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (s) => EDITOR_LABELS[s.name] || s.name;
      this._form.addEventListener("value-changed", (e) => {
        this.dispatchEvent(
          new CustomEvent("config-changed", { detail: { config: e.detail.value } })
        );
      });
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.schema = EDITOR_SCHEMA;
    this._form.data = this._config;
  }
}

/* ------------------------------------------------------------------ *
 * Registration — guard define() so a re-download (HACS update, dashboard
 * reload) can't throw "already defined", and advertise to the card picker.
 * ------------------------------------------------------------------ */

if (!customElements.get("ld2450-room-card")) {
  customElements.define("ld2450-room-card", Ld2450RoomCard);
}
if (!customElements.get("ld2450-room-card-editor")) {
  customElements.define("ld2450-room-card-editor", Ld2450RoomCardEditor);
}

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "ld2450-room-card")) {
  window.customCards.push({
    type: "ld2450-room-card",
    name: "LD2450 Room Card",
    description: "Live top-down position of mmWave (HLK-LD2450) targets on a to-scale room plan.",
    preview: false,
    documentationURL: "https://github.com/dgaust/ld2450-room-card",
  });
}
