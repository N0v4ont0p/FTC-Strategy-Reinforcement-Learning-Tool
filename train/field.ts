// A staged BIOBUZZ world (plain JSON, DSIM's own spawn) for the viewer to draw the field with
// DSIM's real renderer, plus the robot spec the swarm is drawn with.
import { join } from 'node:path';
import { newMatch, type World } from '../harness/dsim';
import { loadProfile, resolve } from '../harness/profiles';
import { ROOT } from './engine';

export function createBiobuzzWorldForViewer(profile: string): World {
  const spec = resolve(loadProfile(join(ROOT, profile))).spec;
  return newMatch(1, [{ id: 0, alliance: 'blue', spec, startIndex: 0 }]);
}
