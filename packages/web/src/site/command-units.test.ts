import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { commandText, commandUnits, type CommandUnit } from './command-units.js';

// Each line's units as one string, a unit's tokens joined by a plus sign, so a case reads whole.
const shown = (lines: readonly (readonly CommandUnit[])[]): string[] => lines.map((units) => units.map((unit) => unit.join('+')).join(' | '));

describe('commandUnits (UI-SPEC line 209, the 05-12 finish review)', () => {
  it('keeps a flag and the value after it in one unit', () => {
    expect(shown(commandUnits('npx cdk deploy --all -c fothering:live=live'))).toEqual(['npx | cdk | deploy | --all | -c+fothering:live=live']);
  });

  it('pairs every flag that takes a value and leaves a flag followed by a flag alone', () => {
    const reopen = 'aws sesv2 put-configuration-set-sending-options --configuration-set-name fothering-bulk --sending-enabled --region eu-central-1';
    expect(shown(commandUnits(reopen))).toEqual(['aws | sesv2 | put-configuration-set-sending-options | --configuration-set-name+fothering-bulk | --sending-enabled | --region+eu-central-1']);
  });

  it('never pairs across a line break, and leaves a flag that ends a line alone', () => {
    expect(shown(commandUnits('npm run build --\nfothering x'))).toEqual(['npm | run | build | --', 'fothering | x']);
  });

  it('gives back exactly the command it was given', () => {
    const token = fc.stringMatching(/^-{0,2}[a-z:=.]{0,4}$/);
    const command = fc.array(fc.array(token, { minLength: 1, maxLength: 6 }), { minLength: 1, maxLength: 3 })
      .map((lines) => lines.map((tokens) => tokens.join(' ')).join('\n'));
    fc.assert(fc.property(command, (text) => commandText(commandUnits(text)) === text));
  });
});
