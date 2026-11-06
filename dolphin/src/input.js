export const BUTTONS = Object.freeze({
  A: 1 << 0,
  B: 1 << 1,
  X: 1 << 2,
  Y: 1 << 3,
  START: 1 << 4,
  L: 1 << 5,
  R: 1 << 6,
  Z: 1 << 7,
  D_UP: 1 << 8,
  D_DOWN: 1 << 9,
  D_LEFT: 1 << 10,
  D_RIGHT: 1 << 11,
  STICK_UP: 1 << 12,
  STICK_DOWN: 1 << 13,
  STICK_LEFT: 1 << 14,
  STICK_RIGHT: 1 << 15,
  C_STICK_UP: 1 << 16,
  C_STICK_DOWN: 1 << 17,
  C_STICK_LEFT: 1 << 18,
  C_STICK_RIGHT: 1 << 19
});

export const CONTROL_LABELS = Object.freeze([
  "A",
  "B",
  "X",
  "Y",
  "START",
  "L",
  "R",
  "Z",
  "D_UP",
  "D_DOWN",
  "D_LEFT",
  "D_RIGHT",
  "STICK_UP",
  "STICK_DOWN",
  "STICK_LEFT",
  "STICK_RIGHT",
  "C_STICK_UP",
  "C_STICK_DOWN",
  "C_STICK_LEFT",
  "C_STICK_RIGHT"
]);

export const DEFAULT_KEY_BINDINGS = Object.freeze({
  KeyX: "A",
  KeyZ: "B",
  KeyV: "X",
  KeyB: "Y",
  Enter: "START",
  KeyQ: "L",
  KeyE: "R",
  KeyC: "Z",
  ArrowUp: "D_UP",
  ArrowDown: "D_DOWN",
  ArrowLeft: "D_LEFT",
  ArrowRight: "D_RIGHT",
  KeyW: "STICK_UP",
  KeyS: "STICK_DOWN",
  KeyA: "STICK_LEFT",
  KeyD: "STICK_RIGHT",
  KeyI: "C_STICK_UP",
  KeyK: "C_STICK_DOWN",
  KeyJ: "C_STICK_LEFT",
  KeyL: "C_STICK_RIGHT"
});

const STANDARD_GAMEPAD_BUTTONS = Object.freeze({
  0: "A",
  1: "B",
  2: "X",
  3: "Y",
  4: "L",
  5: "R",
  8: "Z",
  9: "START",
  12: "D_UP",
  13: "D_DOWN",
  14: "D_LEFT",
  15: "D_RIGHT"
});

export const DEFAULT_PAD_STATE = Object.freeze({
  mask: 0,
  stickX: 0x80,
  stickY: 0x80,
  cStickX: 0x80,
  cStickY: 0x80,
  triggerLeft: 0,
  triggerRight: 0,
  analogA: 0,
  analogB: 0
});

// The Wii Remote pointer port, declared once so every layer clamps to the same geometry.
// The numbers come from the engine's own device code:
//   Source/Core/Core/HW/WiimoteEmu/Camera.h        camera 1024x768, point size capped at 15
//   Source/Core/Core/HW/WiimoteCommon/WiimoteReport.h  ButtonData::BUTTON_MASK = ~0x60e0
// The masked bits are buttons; the unmasked ones carry accelerometer data and must not be
// overwritten by a browser pointer.
export const WIIMOTE_IR = Object.freeze({
  CHANNELS: 4,
  CAMERA_RES_X: 1024,
  CAMERA_RES_Y: 768,
  MAX_POINT_SIZE: 15,
  // 4 camera slots as a real remote reports: slots 0/1 sensor-bar LEDs,
  // slot 2 the aim/target object the game decodes as its pointer, slot 3 spare.
  MAX_POINTS: 4,
  BUTTON_MASK: 0x9f1f
});

// Button bit positions from WiimoteCommon::ButtonData's bitfield, in the order the struct
// declares them. The accelerometer bits are deliberately absent: they belong to the core.
export const WIIMOTE_BUTTON_BITS = Object.freeze({
  left: 1 << 0,
  right: 1 << 1,
  down: 1 << 2,
  up: 1 << 3,
  plus: 1 << 4,
  two: 1 << 8,
  one: 1 << 9,
  b: 1 << 10,
  a: 1 << 11,
  minus: 1 << 12,
  home: 1 << 15
});

// Normalises whatever the host saw into the pointer the core accepts. A remote reports no IR
// object while the trigger is out, so an empty `points` list is a valid payload, not a failure.
export function normalizeWiimotePointer(pointer = {}) {
  const index = Math.min(WIIMOTE_IR.CHANNELS - 1, Math.max(0, Number(pointer.index) || 0)) | 0;
  const buttons = (Number(pointer.buttons) || 0) & WIIMOTE_IR.BUTTON_MASK;
  const points = (Array.isArray(pointer.points) ? pointer.points : [])
    .slice(0, WIIMOTE_IR.MAX_POINTS)
    .map((point) => ({
      x: Math.min(WIIMOTE_IR.CAMERA_RES_X - 1, Math.max(0, Number(point?.x) || 0)) | 0,
      y: Math.min(WIIMOTE_IR.CAMERA_RES_Y - 1, Math.max(0, Number(point?.y) || 0)) | 0,
      size: Math.min(WIIMOTE_IR.MAX_POINT_SIZE, Math.max(0, Number(point?.size) || 0)) | 0
    }));
  return {
    index,
    buttons,
    points,
    signature: `${index}:${buttons}:${points.map((point) => `${point.x},${point.y},${point.size}`).join(":")}`
  };
}

const GAMEPAD_STATE_FIELDS = Object.freeze([
  "mask",
  "stickX",
  "stickY",
  "cStickX",
  "cStickY",
  "triggerLeft",
  "triggerRight",
  "analogA",
  "analogB"
]);

export function resolveKeyboardButton(code, bindings = DEFAULT_KEY_BINDINGS) {
  return bindings[code] ?? null;
}

export function updatePressedSet(pressed, button, isPressed) {
  const next = new Set(pressed);

  if (!button) {
    return next;
  }

  if (isPressed) {
    next.add(button);
  } else {
    next.delete(button);
  }

  return next;
}

export function buttonMaskFromPressed(pressed) {
  let mask = 0;

  for (const button of pressed) {
    mask |= BUTTONS[button] ?? 0;
  }

  return mask >>> 0;
}

// §28ci gamepad deadzones, split into two scales:
//   ANALOG: small, so real-use axis motion reads smoothly through to the
//     emulated stick byte. Too-large here and slow stick movements feel
//     "snapped" / digital.
//   DIGITAL: large, so drift on worn Xbox sticks (commonly idles at
//     0.3-0.45 magnitude) doesn't fire phantom STICK_UP / C_STICK_*
//     pressed events. Those are the events that drive menu navigation
//     and the C-stick camera, so they must be drift-tolerant.
// User-reported symptoms in Chrome (2026-05-25): c-stick moving the
// screen and up-button stuck pressed at rest — both fixed by raising the
// digital threshold past typical Xbox drift.
const DEFAULT_GAMEPAD_ANALOG_DEADZONE = 0.18;
const DEFAULT_GAMEPAD_DIGITAL_DEADZONE = 0.55;

export function selectPreferredGamepad(gamepads) {
  let fallback = null;
  let preferred = null;
  let preferredButtonCount = -1;
  const length = Number(gamepads?.length) || 0;

  for (let index = 0; index < length; index += 1) {
    const gamepad = gamepads[index];
    if (!gamepad) {
      continue;
    }
    fallback ??= gamepad;
    if (gamepad.mapping !== "standard") {
      continue;
    }

    const buttonCount = Number(gamepad.buttons?.length) || 0;
    if (!preferred || buttonCount > preferredButtonCount) {
      preferred = gamepad;
      preferredButtonCount = buttonCount;
    }
  }

  return preferred || fallback;
}

export function gamepadInputsEqual(left, right) {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.pressed?.size !== right.pressed?.size) {
    return false;
  }

  for (const button of left.pressed) {
    if (!right.pressed.has(button)) {
      return false;
    }
  }
  for (const field of GAMEPAD_STATE_FIELDS) {
    if (left.state?.[field] !== right.state?.[field]) {
      return false;
    }
  }
  return true;
}

export function pressedFromGamepad(
  gamepad,
  digitalThreshold = DEFAULT_GAMEPAD_DIGITAL_DEADZONE
) {
  return readGamepadInput(gamepad, digitalThreshold).pressed;
}

export function readGamepadInput(
  gamepad,
  digitalThreshold = DEFAULT_GAMEPAD_DIGITAL_DEADZONE,
  analogDeadzone = DEFAULT_GAMEPAD_ANALOG_DEADZONE
) {
  const pressed = new Set();
  const state = { ...DEFAULT_PAD_STATE };

  if (!gamepad) {
    return { pressed, state };
  }

  for (const [index, button] of Object.entries(STANDARD_GAMEPAD_BUTTONS)) {
    const padButton = gamepad.buttons[Number(index)];
    if (padButton?.pressed) {
      pressed.add(button);
      state.mask |= BUTTONS[button] ?? 0;
    }
  }

  const leftTrigger = gamepad.buttons[6]?.value ?? (gamepad.buttons[4]?.pressed ? 1 : 0);
  const rightTrigger = gamepad.buttons[7]?.value ?? (gamepad.buttons[5]?.pressed ? 1 : 0);
  state.triggerLeft = unitToByte(leftTrigger);
  state.triggerRight = unitToByte(rightTrigger);
  if (state.triggerLeft >= 0x80) {
    pressed.add("L");
    state.mask |= BUTTONS.L;
  }
  if (state.triggerRight >= 0x80) {
    pressed.add("R");
    state.mask |= BUTTONS.R;
  }

  if (gamepad.buttons[0]?.pressed) state.analogA = 0xff;
  if (gamepad.buttons[1]?.pressed) state.analogB = 0xff;

  const [leftX = 0, leftY = 0, rightX = 0, rightY = 0] = gamepad.axes;
  state.stickX = axisToPadByte(leftX, false, analogDeadzone);
  state.stickY = axisToPadByte(leftY, true, analogDeadzone);
  state.cStickX = axisToPadByte(rightX, false, analogDeadzone);
  state.cStickY = axisToPadByte(rightY, true, analogDeadzone);

  if (leftX <= -digitalThreshold) pressed.add("STICK_LEFT");
  if (leftX >= digitalThreshold) pressed.add("STICK_RIGHT");
  if (leftY <= -digitalThreshold) pressed.add("STICK_UP");
  if (leftY >= digitalThreshold) pressed.add("STICK_DOWN");
  if (rightX <= -digitalThreshold) pressed.add("C_STICK_LEFT");
  if (rightX >= digitalThreshold) pressed.add("C_STICK_RIGHT");
  if (rightY <= -digitalThreshold) pressed.add("C_STICK_UP");
  if (rightY >= digitalThreshold) pressed.add("C_STICK_DOWN");

  return { pressed, state };
}

export function mergePressedSets(...sets) {
  const merged = new Set();

  for (const set of sets) {
    for (const button of set) {
      merged.add(button);
    }
  }

  return merged;
}

export function formatControlLabel(label) {
  return label.replaceAll("_", " ");
}

export function inputStateFromPressed(pressed, analogState = null) {
  const state = analogState ? { ...DEFAULT_PAD_STATE, ...analogState } : { ...DEFAULT_PAD_STATE };
  state.mask = buttonMaskFromPressed(pressed) | (state.mask >>> 0);

  applyDigitalAxis(state, pressed, "STICK_LEFT", "STICK_RIGHT", "stickX");
  applyDigitalAxis(state, pressed, "STICK_DOWN", "STICK_UP", "stickY");
  applyDigitalAxis(state, pressed, "C_STICK_LEFT", "C_STICK_RIGHT", "cStickX");
  applyDigitalAxis(state, pressed, "C_STICK_DOWN", "C_STICK_UP", "cStickY");

  if (pressed.has("L")) state.triggerLeft = 0xff;
  if (pressed.has("R")) state.triggerRight = 0xff;
  if (pressed.has("A")) state.analogA = 0xff;
  if (pressed.has("B")) state.analogB = 0xff;

  return state;
}

function applyDigitalAxis(state, pressed, negativeButton, positiveButton, field) {
  const negative = pressed.has(negativeButton);
  const positive = pressed.has(positiveButton);
  if (negative === positive) {
    return;
  }

  state[field] = positive ? 0xe0 : 0x20;
}

function axisToPadByte(axis, invert, deadzone) {
  // §28ci post-deadzone scaling. Without it, axis values just past the
  // deadzone jump to ~deadzone%-of-full immediately, so stick-drift at
  // 0.3-0.4 magnitude that barely clears a 0.2 deadzone still produces
  // a 20%-off-center byte → visible camera drift. Subtract the deadzone
  // and re-scale the surviving 0..1-deadzone range to 0..1 so the byte
  // starts at center and only moves smoothly with real input.
  if (!Number.isFinite(axis)) return clampByte(0x80);
  const mag = Math.abs(axis);
  if (mag < deadzone) return clampByte(0x80);
  const scaled = ((mag - deadzone) / (1 - deadzone)) * Math.sign(axis);
  const oriented = invert ? -scaled : scaled;
  return clampByte(Math.round(0x80 + oriented * 0x60));
}

function unitToByte(value) {
  return clampByte(Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 0xff));
}

function clampByte(value) {
  return Math.max(0, Math.min(0xff, value | 0));
}
