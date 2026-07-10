// Turns "this photo is in album X" into `pictured` entity hints — the one place this connector
// decides which Takeout albums represent PEOPLE. It's an explicit, config-driven allow-list on
// purpose (design decision, issue #77): a wrong `pictured` hint is worse than a missing one, so
// "Italy 2019" is never auto-guessed to be a person. Names are hints only — the connector never
// asserts an entity ID; core resolves each alias against the entity graph (doc 04 §4).
import { readFileSync } from 'node:fs';

const DEFAULTS = { alias_type: 'name', role: 'pictured', confidence: 0.7 };

// config.json shape (see config.example.json):
//   {
//     "person_albums": {
//       "Mom": { "alias": "Jane Doe" },   // album titled "Mom" pictures contact "Jane Doe"
//       "Sarah Jones": {}                    // album title IS the person's name
//     },
//     "person_album_patterns": [             // optional: regex over album titles
//       { "pattern": "^Family: (.+)$", "alias_from_capture": 1 }
//     ],
//     "default_confidence": 0.7,
//     "default_alias_type": "name"
//   }
export function loadPeopleConfig(configPath) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new Error(`gphotos-takeout: could not read people config at ${configPath} (copy config.example.json to config.json): ${err.message}`);
  }
  const albums = raw.person_albums ?? {};
  const patterns = (raw.person_album_patterns ?? []).map((p) => ({
    re: new RegExp(p.pattern),
    aliasFromCapture: p.alias_from_capture ?? null,
    role: p.role, alias_type: p.alias_type, confidence: p.confidence,
  }));
  const defaults = {
    alias_type: raw.default_alias_type ?? DEFAULTS.alias_type,
    role: raw.default_role ?? DEFAULTS.role,
    confidence: raw.default_confidence ?? DEFAULTS.confidence,
  };
  return { albums, patterns, defaults };
}

// Given the set of album titles a (deduped) photo belongs to, produce its `pictured` hints.
// Dedups by alias+role so a photo in two albums that name the same person yields one hint.
export function hintsForAlbums(albumTitles, config) {
  const byKey = new Map();
  const add = (alias, opts) => {
    const hint = {
      alias,
      alias_type: opts.alias_type ?? config.defaults.alias_type,
      role: opts.role ?? config.defaults.role,
      confidence: opts.confidence ?? config.defaults.confidence,
    };
    // Delimiter-free composite key (a JSON tuple) so no alias/role value can collide with the
    // separator — clearer and safer than concatenating with a sentinel character.
    byKey.set(JSON.stringify([hint.alias, hint.role]), hint);
  };

  for (const title of albumTitles) {
    if (title == null) continue;
    const mapped = config.albums[title];
    if (mapped) {
      add(mapped.alias ?? title, mapped);
      continue;
    }
    for (const p of config.patterns) {
      const m = p.re.exec(title);
      if (!m) continue;
      const alias = p.aliasFromCapture != null ? m[p.aliasFromCapture] : title;
      if (alias) add(alias, p);
    }
  }
  return [...byKey.values()];
}
