// The user-approved voice vocabulary for Agent Code agents, strongest first.
//
// WHY the ORDER is part of the contract and this list is append-only: the
// registry stores the assigned STRING, not an index, but it picks new names by
// walking this ranking. Reordering therefore does not rename an existing agent
// — it silently changes which name the next agent gets, so two machines that
// disagree about this file hand out different addresses for the same workload.
// Deleting an entry is worse: an assignment already on disk keeps that name
// while `agents.search` can no longer be told about it from here.
//
// WHY names and titles are different things: a title describes the TASK ("fix
// the queue race") and the user edits it freely. A name addresses the AGENT
// DOING it and must stay legible over a voice channel, which is why these are
// short, common, ordinary given names rather than anything generated. Never
// derive one from the other.
//
// WHAT THIS LIST IS NOT: phonetically validated. It is spelling-unique and
// user-ranked, and nothing more was verified. The strong head is where the
// separation actually lives; the tail deliberately trades it for shortness and
// clusters audibly — Flora/Cora/Nora/Lena, Theo/Leo/Milo, Athena/Helena. That
// is acceptable because names are assigned in rank order, so a workspace only
// reaches the tail once it already holds dozens of agents, and because every
// name is also shown in writing beside the title. It is NOT acceptable as an
// assumption: nothing downstream may treat a spoken utterance as unambiguously
// identifying one agent. `agents.search` matches on the normalized string, and
// an ambiguous match is the caller's problem to disambiguate, not this list's
// to have prevented.
//
// WHY overflow uses an explicit " 2" suffix instead of wrapping: past 100 live
// identities the pool is exhausted, and reusing "Apollo" would make a spoken
// address ambiguous at the exact moment the workspace is busiest. "Apollo 2" is
// still sayable and still unique. Never recycle a retired name to avoid it.
//
// `as const` is deliberate: it makes the tuple readonly, so nothing can push,
// splice or sort the vocabulary at runtime and quietly break the ordering
// contract above. The edge it brings: the element type is the literal union,
// not `string`, so `AGENT_NAMES.includes(someUserInput)` does not type-check.
// The widened view is always the normalized one —
// `AGENT_NAMES.map(normalizeAgentName).includes(normalizeAgentName(input))` —
// and that is the only membership idiom this feature uses, because a raw
// case-sensitive compare against a spoken address is wrong anyway. Note that
// name LOOKUP never scans this list at all: `agents.search` compares the
// normalized input against each agent's ASSIGNED name, which is the only thing
// that can include an overflow suffix ("Apollo 2") or a name whose rank has
// since moved.
export const AGENT_NAMES = [
  'Apollo', 'Jasper', 'Beatrix', 'Duncan', 'Felix', 'Gloria', 'Hugo', 'Ingrid', 'Oscar', 'Sasha',
  'Trevor', 'Violet', 'Xander', 'Morgan', 'Hazel', 'Cedric', 'Bruno', 'Esther', 'Daphne', 'Orion',
  'Athena', 'Tobias', 'Matilda', 'Dominic', 'Octavia', 'Sebastian', 'Penelope', 'Gabriel', 'Miranda', 'Frederick',
  'Savannah', 'Julian', 'Natalie', 'Benjamin', 'Valerie', 'Artemis', 'Vanessa', 'Gideon', 'Cosmo', 'Sabrina',
  'Franklin', 'Veronica', 'Malcolm', 'Ramona', 'Leonardo', 'Camilla', 'Donovan', 'Helena', 'Solomon', 'Clementine',
  'Oliver', 'Cassandra', 'Dexter', 'Phoebe', 'Winston', 'Delilah', 'Marcus', 'Naomi', 'Arthur', 'Fiona',
  'Vincent', 'Tabitha', 'Edward', 'Monica', 'Simon', 'Greta', 'Patrick', 'Zelda', 'Calvin', 'Ruby',
  'Amber', 'Petra', 'Jonah', 'Willow', 'Flora', 'Yuki', 'Iris', 'Cora', 'Lena', 'Nora',
  'Lucy', 'Rory', 'Theo', 'Ada', 'Eli', 'Uma', 'Zane', 'Milo', 'Leo', 'Finn',
  'Max', 'Gus', 'Blake', 'Quinn', 'Sage', 'Knox', 'Reese', 'Wes', 'Kit', 'Kai',
] as const

// Spoken-equivalence normalization, used for BOTH uniqueness checks in the
// registry and exact name lookup in agents.search. It deliberately does not
// strip the space before a suffix: a transcriber emits "Apollo two" as
// "Apollo 2", never as "Apollo2", so folding them together would let one
// utterance match two different agents.
export const normalizeAgentName = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase()
export function agentNameAt(index: number): string {
  const cycle = Math.floor(index / AGENT_NAMES.length)
  const name = AGENT_NAMES[index % AGENT_NAMES.length]
  return cycle === 0 ? name : `${name} ${cycle + 1}`
}
