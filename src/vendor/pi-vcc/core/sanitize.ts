// @ts-nocheck
// Vendored from @sting8k/pi-vcc@0.8.0 (MIT) by scripts/sync-pi-vcc.ts. Do not edit.
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

export const sanitize = (text: string): string =>
  text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(ANSI_RE, "").replace(CTRL_RE, "");
