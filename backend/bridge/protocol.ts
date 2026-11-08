export type Telemetry = {
  device_id: "UNO_R4";
  water_level_pct: number | null;
  wet: boolean;
  tilt: boolean;
  shock: boolean;
};
export function parseTelemetry(line: string): Telemetry {
  if (line.length > 1024)
    throw new Error("Serial frame exceeds 1024 characters");
  const p = JSON.parse(line) as Telemetry;
  if (
    !p ||
    p.device_id !== "UNO_R4" ||
    ["wet", "tilt", "shock"].some((k) => typeof p[k as "wet"] !== "boolean") ||
    (p.water_level_pct !== null &&
      (typeof p.water_level_pct !== "number" ||
        !Number.isFinite(p.water_level_pct) ||
        p.water_level_pct < 0 ||
        p.water_level_pct > 100))
  )
    throw new Error("Invalid sensor packet");
  return p;
}
export class LineFramer {
  private buffer = "";
  private dropping = false;
  constructor(
    private line: (line: string) => void,
    private invalid: (message: string) => void = () => {},
  ) {}
  push(chunk: string) {
    for (const char of chunk) {
      if (char === "\n") {
        if (!this.dropping && this.buffer.trim()) this.line(this.buffer.trim());
        this.buffer = "";
        this.dropping = false;
      } else if (!this.dropping) {
        this.buffer += char;
        if (this.buffer.length > 1024) {
          this.buffer = "";
          this.dropping = true;
          this.invalid("Dropped oversized serial frame");
        }
      }
    }
  }
}
export const mockReading = (i: number): Telemetry => ({
  device_id: "UNO_R4",
  water_level_pct: Math.min(98, 55 + i * 1.5),
  wet: i >= 20,
  tilt: i === 10,
  shock: i === 15,
});
