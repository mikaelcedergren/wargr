# Writing baseline audit

Date: 27 October 2026. Source baseline: `d53c707a634ba2b638eeeb417ab11fed42d4f397`, before the writing-system revision.

This audit covers the five published story snapshots and the instructions used by the Admin
polishing service. It identifies observable textual and implementation features, followed by
editorial judgments about their effect. It does not establish who wrote a passage. No reader
study, authorship detector, or live provider experiment was conducted for this audit. Private
drafts, credentials, and operational article records were not inspected.

## Diagnosis across the collection

The stories repeatedly move from an observation to an explanation, then to a compact verdict
about its meaning. Long explanatory passages and isolated emphatic sentences produce a
recognisable cadence even when the subjects differ. My editorial judgment is that this
predictability makes the narrator feel performed and reduces the reader's opportunity to
discover meaning.

Specificity is uneven. A memory or concrete economic pressure can give a passage substance;
later paragraphs often replace those particulars with generalised accounts of what people
think, fear, or do. Emotional emphasis sometimes increases while the evidence and understanding
remain unchanged. These are problems of selection, movement, and authority, not merely words to
ban.

| Published story                                                                                 | Observable feature                                                                                                                                                                                                                                                     | Editorial judgment and material to preserve                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [The strange mercy of death](../../src/app/articles/mercy-of-death.component.ts)                | Treatment cycles, children on the ward, and family changes lead into repeated explanations of being unable to experience one's own absence. Several short paragraphs separately announce emotional turns.                                                              | The lived circumstances give the story stakes. The later explanation approaches its conclusion several times, weakening forward movement. Preserve actual memories and their uncertainty; reduce repeated interpretation rather than manufacturing further scenes.                           |
| [The side effect of knowing yourself](../../src/app/articles/knowing-yourself.component.ts)     | A sister's remark becomes broad claims about confidence and self-knowledge. The vocabulary shifts towards abstractions such as “substrate.” The conversation occurs at eighteen, but its aftermath is described as the next ten years between fifteen and twenty-five. | The awkward exchange and the wish for reassurance offer human interest. Subsequent generalisations need clearer limits, and the chronology requires the author's factual resolution. A line editor must not silently choose an age.                                                          |
| [How fear turns the good in us into corruption](../../src/app/articles/corruption.component.ts) | A hypothetical institution develops through livelihood and dependency into corruption. The account then makes confident claims about what almost nobody notices and what the reader would do.                                                                          | The causal sequence is useful. Keep the example explicitly hypothetical and distinguish plausible mechanisms from universal claims. This material can work as plain reasoning; it does not require an invented autobiographical opening.                                                     |
| [The whore of Babylon was always us](../../src/app/articles/babylons-whore.component.ts)        | The opening invokes unspecified intelligent people, old texts, and lives held together by religion. Later “room,” “body,” and “cup” imagery repeatedly carries the argument.                                                                                           | The claimed change of mind lacks enough identifiable grounds for readers to follow it. Religious imagery can support interpretation, but cannot replace stating which idea or observation mattered and why. This is one instance of the collection's exactness problem, not its sole source. |
| [How we choose the slaughterhouse](../../src/app/articles/slaughterhouse.component.ts)          | An unnamed film and public figure support a pivotal interpretation; repeated cattle and fence imagery reinforces the conclusion.                                                                                                                                       | The reader cannot adequately assess the central example. The narrator's participation in conformity is useful, but declaring what readers secretly do can obstruct connection. Explain the grounds and preserve room for disagreement.                                                       |

All five generated bodies occupied line 7 of their respective components at the baseline.
They are publication snapshots, not authoring files; this audit does not authorise editing them.

Subsequent author clarification: the unnamed figure in Slaughterhouse is a villain, and its identity
is deliberately unnecessary for the reader. That correction supersedes any inference above that
anonymity alone is a defect. The review question is whether the relevant interpretation is
intelligible, not whether every character or film has been named. See [WRITING.md](../../WRITING.md).

## Instruction and runtime findings

The baseline [voice contract](../../server/src/voice-contract.ts) already prohibited moral
summaries, matching sentence grammar, decorative body imagery, repeated explanations, and
stacked endings. Their appearance in the stories cannot be solved simply by adding the same
prohibitions again.

The contract also positively encouraged a raw, visceral, reflective persona; supplied bodily
vocabulary and model sentences; preferred cumulative sentences; and repeatedly described a
personal opening followed by a damaged belief and an earned insight. Some of its examples
appear in the published stories. **Editorial inference:** these positive models may encourage
the performance that the prohibitions attempt to restrain. The audit cannot reconstruct which
instruction generated any individual passage.

The baseline contract and [AGENTS.md](../../AGENTS.md) treated the author's edits primarily as
meaning, allowing wording to be replaced. This supports deliberate full ghostwriting, but also
allows a later pass to erase a correction made specifically to establish voice. The appropriate
scope of rewriting must be explicit for each pass.

The baseline [output contract](../../server/src/polish-content.ts) requested the story alongside
an intriguing ingress, social posts, and hook/expansion pull quotes. **Editorial inference:**
asking for those together creates an avoidable incentive towards quotable statements. That is
a hypothesis to test, not an established cause of the published prose. The existing photographic
image style is independent of this concern and should remain intact.

The same implementation assembled provider input from the current document plus the current
round instruction. It did not supply earlier corrections, rejected phrases, raw-source
provenance, or a retrieved set of accepted voice examples. Although version history existed,
the prompt did not receive it. Therefore, the contract's description of an ongoing learning
relationship overstated the actual context available to each call. A future system must name
exactly what it remembers and actually provide that material; documentation alone cannot create
automatic feedback learning.

## Consequences for the replacement guidance

- Require consequential referents and causal steps to be understandable. Naming every person is
  unnecessary when a relationship supplies enough context. Missing knowledge must not be
  repaired with atmospheric language or invented detail.
- Treat a missing factual hinge as an unresolved editorial issue. Ask for the missing fact,
  narrow the claim, or omit it. Do not represent an unresolved passage as publication-ready.
- Choose form from the material. Memory, observation, explanation, argument, humour, and an
  unresolved inquiry should not all acquire the same conversion arc.
- Let personality emerge through particular attention, judgments, interests, and a consistent
  relationship with readers. Do not equate identity with a repeated sentence pattern or constant
  emotional intensity.
- Judge pacing by changes in events, evidence, stakes, and understanding. Word counts, sentence
  lengths, and tell counts are inspection aids, not a definition of human prose.
- Require every claimed improvement to survive comparison with the original. A fluent
  replacement can be less exact or less individual.
- Separate evidence of correct prompt assembly from evidence of reader response. Synthetic
  samples and model reviews can expose failures; they cannot establish human connection or a
  numerical guarantee of success.

The existing corpus is useful diagnostic material. It should not automatically become the
positive reference set for a voice the author has explicitly rejected. This audit proposes no
changes to the published stories, logo, or image style.
