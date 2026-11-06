/**
 * The one-spell entry: the PRD's proof that importing a single spell ships no other spell's code.
 * It imports exactly what a game needs for Fireball and nothing else, and `pnpm check:one-spell`
 * bundles it and greps for the other five spells' names.
 */
import { CastPool, SpellWorld, createFireball } from "@threenative/core/spells";

export { CastPool, SpellWorld, createFireball };
