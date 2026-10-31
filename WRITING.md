# Writing for Wargr

On 27 October 2026, Michael approved the complete Babylon reading draft, called it “2000% better”,
and asked for this voice to guide the rest of his stories. This is the accepted editorial direction.
The exact reference is preserved in [voice-reference.ts](server/src/voice-reference.ts), alongside
his later four-paragraph pacing example. His subsequent rhythm corrections govern new work; the
Babylon edition remains intact as the record of what he first approved. Approval of that piece is
evidence of the author's preference, not a measured guarantee of future audience response.

## Read before writing

1. [The canonical voice instructions and editing scopes](server/src/voice-contract.ts).
2. [The complete approved Babylon example and later pacing example](server/src/voice-reference.ts),
   reading the whole piece and the accompanying explanation of the later preference.
3. [Examples and editorial observations](docs/writing/examples.md), which explain useful choices
   without turning the example into a template.
4. The current story's actual material, requested scope, and explicit author corrections.

`voice-contract.ts` is the single owner of prose instructions. `voice-reference.ts` is the single
owner of the accepted examples and their model-facing framing. Both are normal compiled
server modules; `polish-content.ts` includes them in every polish request. This document owns the
editorial workflow and evidence, not a competing specification. Do not maintain another active
copy of the contract or the complete exemplar in a Markdown file.

## Responsibility

Michael is a designer supplying ideas, experiences, convictions and key phrases. The ghostwriter
owns composition, language, rhythm, emphasis, humour and the reader's experience. Do not require
him to provide a polished draft, imitate a favourite writer, or repair the writer's prose.

Full ghostwriting may rebuild a piece around his meaning. It must preserve facts, his position,
meaningful uncertainty and any wording he explicitly settles. Most subjects are serious and need
emotional impact. Precision must not become timid, lifeless explanation; intensity must not
become invented experience or manufactured profundity.

The logo and photographic image style remain their own visual identity. They do not require
every passage to sound solemn, dark or physically distressed.

## Pacing belongs to the voice

The author's later feedback makes meaning and direction the basis of pacing. Understand what the
whole piece says, where it is going, and what the reader needs to know, feel or anticipate before
deciding where to pause. A paragraph can continue the same topic after a break because the reader
needs a moment with the thought just delivered. Commas, sentence boundaries and paragraph breaks
work together; varying their lengths without understanding that progression is insufficient.

During development, take natural openings to connect related clauses into longer sentences. Give
the thought room, and retain the break if joining it would require padding or strained grammar.
Short sentences and standalone paragraphs remain valuable when their pauses have a purpose.
There is no target ratio, required sequence or preferred paragraph size. The
[examples and notes](docs/writing/examples.md#the-authors-later-pacing-refinement) explain this
refinement and the author-supplied opening without turning them into another template.

## Produce a story

1. **Establish the intended meaning.** Identify the author's central thought, position, important
   phrases and actual material. Distinguish remembered events, external evidence, interpretation
   and proposed illustrations. Do not demand a finished outline.
2. **Find the reader's reason to stay.** Identify the question, consequence, conflict, relationship
   or observation that warrants attention. In serious material, understand what somebody stands
   to lose or what has already happened to them. Do not manufacture stakes or demand tragedy.
   Understand the whole progression and how each next passage will use what came before; pacing
   choices follow from that understanding.
3. **Compose the piece.** Choose its entry, sequence, distribution of attention and stopping point.
   Use the freedom of the requested editing scope. An argument need not acquire a personal scene;
   a recollection need not become a conversion.
4. **Read for movement and feeling.** Identify where interest or emotional involvement weakens.
   Remove repeated explanation. Expand from supplied or verified material. Reflection, atmosphere,
   humour and time with a person can earn space without adding another factual proposition.
5. **Edit the prose.** Let meaning determine rhythm. Replace vague claims with exact ones and remove
   automatic verdicts. While a thought is developing, take natural opportunities to connect related
   clauses into longer sentences rather than stopping after each statement. Keep a break when the
   join would be forced, and let short sentences and paragraph breaks mark a meaningful pause.
   Read each passage into the next to judge the effect. Keep language that gives particular
   pleasure or force. Do not replace one mannerism with blanket minimalism.
6. **Prepare supporting copy.** Derive the title, ingress, social posts and pull quotes from what the
   finished piece actually does. Do not reshape its body to make those fields easier to fill.
   Review the title and ingress together before checking the article's payoff. Apply the canonical
   contract's distinct purpose for the ingress: inducing curiosity, without requiring it to settle
   the thought. Preserve the established image-style instruction.
7. **Deliver the complete draft for reading.** The author judges whether the result expresses what
   he means and connects as intended. Keep substantive corrections and explicitly record general
   voice decisions that he accepts.

These are editorial activities, not seven separately implemented model calls. The worker returns
a complete replacement document from one request. Mechanical field validation does not establish
truth, editorial readiness, or audience response.

## Facts and missing material

A missing factual hinge remains an editorial question. Do not fabricate an answer, disguise the gap
with atmosphere, or silently replace the central argument with an easier one. In a conversation,
ask for the missing information. The automated round currently has no separate editorial-question
field; it must keep unsupported claims bounded and cannot honestly claim to complete a long-form
treatment that depends on missing evidence. Do not put editorial placeholders in public prose.

The approved reference calibrates the writing. Its biography, religious interpretation, experiment,
fundraiser and vocabulary are not source material for unrelated stories. Hypothetical examples
must remain visibly hypothetical. A new source or numerical claim requires verification; a
remembered event requires the author's material, not a plausible reconstruction.

Exactness concerns intelligible meaning, not compulsory identification. On 27 October the author
clarified that Slaughterhouse concerns an unnamed villain in a superhero film, and that the reader
does not need the villain's identity. Preserve deliberate allusions when the relevant conduct or
interpretation is understandable. Do not request names merely to satisfy a formula, change the
character's role, or turn narrative into a citation-heavy explanation. Distinguish an interpretation
from independently established creator intent without draining the author's conviction.

## Persistence and source ownership

Every polish request receives the canonical instructions, the full approved reference, its selected
editing scope, the current story document and the current round instruction. Stored rounds and
past conversations are not automatically supplied to the model. The worker does not learn from
silence, publication, or history merely existing in the database.

- Record an accepted general preference in the canonical contract with enough context to apply it.
  Keep a story-specific correction in that story's current instruction or supplied material.
- Add another reference only after explicit author acceptance. Preserve its exact accepted edition,
  source brief and relevant acceptance note. Do not edit an approved reference silently as taste
  changes; a replacement requires its own acceptance.
- Existing published prose is not automatically a positive example. The older corpus was the
  diagnostic baseline for this change.
- Keep private biography, draft history and records in the existing authoring store. Source files
  may contain only intentionally recorded preferences and approved examples suitable for the
  repository. Never copy private drafts into tests or casually committed reference files.
- Runtime changes affect a worker only after it loads that version through normal development or
  release delivery. A source edit alone is not evidence that production uses the new instructions.

Stories themselves are authored in the Admin database. Generated Angular components are publication
snapshots and must not be edited to change article prose. Publication remains separate from drafting
and follows [AGENTS.md](AGENTS.md#publishing).

## Review and maintenance

Read complete pieces for source fidelity, exactness, sustained attention, emotional effect,
distinct presence, rhythm and their stopping point. Cite actual passages when identifying a
failure. An average score must not conceal a factual error or a dull middle.

Use varied material when changing the contract: serious recollection, an argument without a
personal scene, ordinary experience, sparse notes, unresolved feeling and an effective passage
needing only a line edit. Test the assigned operation. A final polish that rewrites everything
fails its scope even if its replacement is fluent. Compare pieces for repeated opening moves,
paragraph conclusions, imagery and endings.

Model comparisons can expose invented details, unsupported claims, monotonous cadence or changed
meaning. They do not certify that prose sounds human or demonstrate audience connection. The
author-approved Babylon piece is the current positive reference. Further explicit feedback on
whole pieces should refine the direction without resetting the voice after every isolated reaction.

## Supporting evidence

- [Research and author-craft sources](docs/writing/research.md).
- [Baseline audit of the five published stories and previous runtime](docs/writing/audit.md).
- [Trial findings, author acceptance and remaining limits](docs/writing/validation.md).

The research informs the approach and the need to evaluate it. The Wargr voice is an editorial
choice accepted through reading, not a scientific deduction or a detector-evasion technique.
