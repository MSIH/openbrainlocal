// Org-kind business contacts + person->org employment edges (#88). Drives the real
// importContacts path against a fake Ollama + temp DB, and reads back the entity graph
// (entities.kind, entity_relations, unresolved_aliases) and aboutEntity's relations/relations_in.
// The load-time kind='org' data migration is covered separately in org-migration.test.mjs (it
// needs a fresh process per reopen). DB_PATH + OLLAMA_BASE_URL are set before contacts.js loads.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb, startFakeOllama } from './helpers.mjs';

const { cleanup } = useTempDb();
const fake = await startFakeOllama();
process.env.OLLAMA_BASE_URL = fake.baseUrl;

const { importContacts } = await import('../src/contacts.js');
const { db } = await import('../src/db.js');
const { aboutEntity } = await import('../src/search.js');

after(async () => { db.close(); await fake.close(); cleanup(); });

const vcard = (body) => `BEGIN:VCARD\nVERSION:3.0\n${body}\nEND:VCARD\n`;
const kindOf = (name) => db.prepare('SELECT kind FROM entities WHERE canonical_name = ?').get(name)?.kind;
const stagedWorksAt = (alias) => db.prepare(
  "SELECT * FROM unresolved_aliases WHERE alias = ? AND alias_type = 'relation' AND role = 'worksAt'"
).all(alias);

test('company vCard -> kind=org; person vCard -> kind=person; re-import is idempotent (kind stable, no dup)', async () => {
  await importContacts(vcard('FN:Globex\nX-ABSHOWAS:COMPANY\nEMAIL:info@globex.example'));
  await importContacts(vcard('FN:Jane Human\nEMAIL:jane.human@example.com'));
  assert.equal(kindOf('Globex'), 'org');
  assert.equal(kindOf('Jane Human'), 'person');

  // vCard 4.0 KIND:org is the other company signal.
  await importContacts(vcard('FN:Initech\nKIND:org\nEMAIL:hi@initech.example'));
  assert.equal(kindOf('Initech'), 'org');

  const again = await importContacts(vcard('FN:Globex\nX-ABSHOWAS:COMPANY\nEMAIL:info@globex.example'));
  assert.equal(again.skipped, 1, 're-import dedups');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM entities WHERE canonical_name = 'Globex'").get().n, 1);
  assert.equal(kindOf('Globex'), 'org', 'kind stays org on re-import');
});

test('person with ORG then the company contact -> worksAt edge (person->org); about_entity shows both sides', async () => {
  await importContacts(vcard('FN:Alice Worker\nEMAIL:alice@acme.example\nORG:Acme;Engineering'));
  // Before the company exists, the ORG name is staged, never fabricated into an org entity.
  assert.equal(kindOf('Acme'), undefined, 'no org entity invented from a free-text ORG string');
  assert.equal(stagedWorksAt('acme').length, 1, 'the worksAt hint is staged on the person artifact');

  await importContacts(vcard('FN:Acme\nX-ABSHOWAS:COMPANY\nEMAIL:contact@acme.example'));
  assert.equal(kindOf('Acme'), 'org');

  const person = aboutEntity('Alice Worker').entities[0];
  const edge = person.relations.find((r) => r.relation_type === 'worksAt');
  assert.ok(edge, 'person has an outgoing worksAt edge');
  assert.equal(edge.name, 'Acme');

  const org = aboutEntity('Acme').entities[0];
  const inbound = org.relations_in.find((r) => r.relation_type === 'worksAt');
  assert.ok(inbound, 'org lists the employee via relations_in');
  assert.equal(inbound.name, 'Alice Worker');
});

test('reverse import order (company first, then the person) forms the same worksAt edge', async () => {
  await importContacts(vcard('FN:Umbrella\nKIND:org\nEMAIL:corp@umbrella.example'));
  await importContacts(vcard('FN:Bob Staff\nEMAIL:bob@umbrella.example\nORG:Umbrella'));

  const person = aboutEntity('Bob Staff').entities[0];
  assert.ok(person.relations.some((r) => r.relation_type === 'worksAt' && r.name === 'Umbrella'));
  const org = aboutEntity('Umbrella').entities[0];
  assert.ok(org.relations_in.some((r) => r.relation_type === 'worksAt' && r.name === 'Bob Staff'));
});

test('a person whose ORG matches no company contact fabricates no org entity, leaves a staged hint', async () => {
  await importContacts(vcard('FN:Carol Solo\nEMAIL:carol@example.com\nORG:Nonexistent Co;Sales'));
  assert.equal(kindOf('Nonexistent Co'), undefined, 'no entity created for an unmatched ORG');
  assert.equal(stagedWorksAt('nonexistent co').length, 1, 'the hint stays staged, resolvable later');
  // Match is on the ORG NAME (parts[0]), not the joined "org, department" display string.
  assert.equal(stagedWorksAt('nonexistent co, sales').length, 0);
});

test('an org contact never self-links via its own ORG line', async () => {
  // A company card can carry an ORG too; the !isCompany guard means it never becomes a worksAt hint.
  await importContacts(vcard('FN:Wayne Enterprises\nKIND:org\nORG:Wayne Enterprises\nEMAIL:info@wayne.example'));
  const org = aboutEntity('Wayne Enterprises').entities[0];
  assert.equal(org.relations.length, 0, 'no outgoing edge');
  assert.equal(stagedWorksAt('wayne enterprises').length, 0, 'no staged self-hint');
});
