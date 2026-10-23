// How a command an operator copies is cut into wrapping units (UI-SPEC line 209: a command wraps at
// its spaces). Each line of the command is its own run of units. A unit is one token, or a flag
// with the value after it, so a line never ends between -c and fothering:live=live while the pair
// fits; a flag followed by another flag, or ending its line, stands alone.

export type CommandUnit = readonly string[];

const isFlag = (token: string): boolean => token.startsWith('-');
const isValue = (token: string | undefined): token is string => token !== undefined && token !== '' && !isFlag(token);

function lineUnits(tokens: readonly string[]): CommandUnit[] {
  const units: CommandUnit[] = [];
  let at = 0;
  while (at < tokens.length) {
    const token = tokens[at] ?? '';
    const next = tokens[at + 1];
    const paired = isFlag(token) && isValue(next);
    units.push(paired ? [token, next] : [token]);
    at += paired ? 2 : 1;
  }
  return units;
}

// A token wider than its column otherwise breaks wherever the column runs out (FotheringAction:
// OperatorAddre / ss in a quarter-width deploy step at 1440 px). A run ends after each inner colon
// and equals sign, so a line can end between a stack, its parameter and the value. Chromium already
// breaks before the < of <address>; the explicit run keeps that in a browser that does not.
export function tokenRuns(token: string): string[] {
  return token.split(/(?<=[:=])(?=.)/);
}

export function commandUnits(command: string): CommandUnit[][] {
  return command.split('\n').map((line) => lineUnits(line.split(' ')));
}

// The text the units stand for: one space inside a unit and between units, a line break between
// lines, so the copied text is the command itself.
export function commandText(lines: readonly (readonly CommandUnit[])[]): string {
  return lines.map((units) => units.map((unit) => unit.join(' ')).join(' ')).join('\n');
}
