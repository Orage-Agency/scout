import { UiohookKey } from "uiohook-napi";
import { Key } from "@nut-tree-fork/nut-js";

// uIOhook keycode → nut.js Key. Unmapped keys are skipped during replay.
export const KEY_MAP: Record<number, Key> = {
  // Letters
  [UiohookKey.A]: Key.A, [UiohookKey.B]: Key.B, [UiohookKey.C]: Key.C,
  [UiohookKey.D]: Key.D, [UiohookKey.E]: Key.E, [UiohookKey.F]: Key.F,
  [UiohookKey.G]: Key.G, [UiohookKey.H]: Key.H, [UiohookKey.I]: Key.I,
  [UiohookKey.J]: Key.J, [UiohookKey.K]: Key.K, [UiohookKey.L]: Key.L,
  [UiohookKey.M]: Key.M, [UiohookKey.N]: Key.N, [UiohookKey.O]: Key.O,
  [UiohookKey.P]: Key.P, [UiohookKey.Q]: Key.Q, [UiohookKey.R]: Key.R,
  [UiohookKey.S]: Key.S, [UiohookKey.T]: Key.T, [UiohookKey.U]: Key.U,
  [UiohookKey.V]: Key.V, [UiohookKey.W]: Key.W, [UiohookKey.X]: Key.X,
  [UiohookKey.Y]: Key.Y, [UiohookKey.Z]: Key.Z,

  // Digits (top row)
  [UiohookKey["0"]]: Key.Num0,
  [UiohookKey["1"]]: Key.Num1,
  [UiohookKey["2"]]: Key.Num2,
  [UiohookKey["3"]]: Key.Num3,
  [UiohookKey["4"]]: Key.Num4,
  [UiohookKey["5"]]: Key.Num5,
  [UiohookKey["6"]]: Key.Num6,
  [UiohookKey["7"]]: Key.Num7,
  [UiohookKey["8"]]: Key.Num8,
  [UiohookKey["9"]]: Key.Num9,

  // Whitespace / control
  [UiohookKey.Space]: Key.Space,
  [UiohookKey.Enter]: Key.Enter,
  [UiohookKey.Tab]: Key.Tab,
  [UiohookKey.Backspace]: Key.Backspace,
  [UiohookKey.Escape]: Key.Escape,
  [UiohookKey.CapsLock]: Key.CapsLock,
  [UiohookKey.Delete]: Key.Delete,
  [UiohookKey.Insert]: Key.Insert,

  // Navigation
  [UiohookKey.Home]: Key.Home,
  [UiohookKey.End]: Key.End,
  [UiohookKey.PageUp]: Key.PageUp,
  [UiohookKey.PageDown]: Key.PageDown,
  [UiohookKey.ArrowLeft]: Key.Left,
  [UiohookKey.ArrowRight]: Key.Right,
  [UiohookKey.ArrowUp]: Key.Up,
  [UiohookKey.ArrowDown]: Key.Down,

  // Modifiers
  [UiohookKey.Shift]: Key.LeftShift,
  [UiohookKey.ShiftRight]: Key.RightShift,
  [UiohookKey.Ctrl]: Key.LeftControl,
  [UiohookKey.CtrlRight]: Key.RightControl,
  [UiohookKey.Alt]: Key.LeftAlt,
  [UiohookKey.AltRight]: Key.RightAlt,
  [UiohookKey.Meta]: Key.LeftSuper,
  [UiohookKey.MetaRight]: Key.RightSuper,

  // Function keys
  [UiohookKey.F1]: Key.F1, [UiohookKey.F2]: Key.F2, [UiohookKey.F3]: Key.F3,
  [UiohookKey.F4]: Key.F4, [UiohookKey.F5]: Key.F5, [UiohookKey.F6]: Key.F6,
  [UiohookKey.F7]: Key.F7, [UiohookKey.F8]: Key.F8, [UiohookKey.F9]: Key.F9,
  [UiohookKey.F10]: Key.F10, [UiohookKey.F11]: Key.F11, [UiohookKey.F12]: Key.F12,

  // Punctuation
  [UiohookKey.Semicolon]: Key.Semicolon,
  [UiohookKey.Equal]: Key.Equal,
  [UiohookKey.Comma]: Key.Comma,
  [UiohookKey.Minus]: Key.Minus,
  [UiohookKey.Period]: Key.Period,
  [UiohookKey.Slash]: Key.Slash,
  [UiohookKey.Backquote]: Key.Grave,
  [UiohookKey.BracketLeft]: Key.LeftBracket,
  [UiohookKey.Backslash]: Key.Backslash,
  [UiohookKey.BracketRight]: Key.RightBracket,
  [UiohookKey.Quote]: Key.Quote,
};

export const RELEASE_ON_ABORT: Key[] = [
  Key.LeftShift, Key.RightShift,
  Key.LeftControl, Key.RightControl,
  Key.LeftAlt, Key.RightAlt,
  Key.LeftSuper, Key.RightSuper,
];

export function mapKeycode(uiohookKeycode: number | undefined): Key | null {
  if (uiohookKeycode === undefined) return null;
  const k = KEY_MAP[uiohookKeycode];
  return k === undefined ? null : k;
}
