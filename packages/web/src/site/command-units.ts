// How a command an operator copies is cut into wrapping units (UI-SPEC line 209: a command wraps at
// its spaces). Each line of the command is its own run of units, and a unit is one token.

export type CommandUnit = readonly string[];

export function commandUnits(command: string): CommandUnit[][] {
  return command.split('\n').map((line) => line.split(' ').map((token) => [token]));
}

// The text the units stand for: one space inside a unit and between units, a line break between
// lines, so the copied text is the command itself.
export function commandText(lines: readonly (readonly CommandUnit[])[]): string {
  return lines.map((units) => units.map((unit) => unit.join(' ')).join(' ')).join('\n');
}
