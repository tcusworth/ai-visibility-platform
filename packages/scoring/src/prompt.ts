export interface VisibilityScorerPromptProfile {
  targetDisplayName: string;
  targetShortName: string;
  targetReferences: string[];
  mentionedField: string;
  citedField: string;
  positioningField: string;
  allowedEntityTypes: string[];
  controlledSourceExample?: string;
}

export interface VisibilityScorerPromptInput {
  profile: VisibilityScorerPromptProfile;
  platform: string;
  model: string;
  prompt: string;
  answer: string;
  sourceUrls: string[];
  sourceDomains: string[];
}

function naturalList(values: string[]): string {
  if (values.length === 0) return "";
  if (values.length === 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} or ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, or ${values.at(-1)}`;
}

export function buildVisibilityScorerPrompt(input: VisibilityScorerPromptInput): string {
  const p = input.profile;
  const targetRefs = p.targetReferences.map((value) => `- ${value}`);
  const entityTypes = p.allowedEntityTypes.map((value) => `- ${value}`);
  const controlledSourcePhrase = p.controlledSourceExample
    ? ` such as ${p.controlledSourceExample}`
    : "";

  return [
    `You are evaluating AI visibility for ${p.targetDisplayName}.`,
    "",
    `Known ${p.targetShortName} entity references:`,
    ...targetRefs,
    "",
    "Evaluate ONLY the supplied benchmark answer and sources.",
    "Do not use outside knowledge.",
    "",
    "Return ONLY valid JSON with this structure:",
    "",
    "{",
    `  \"${p.mentionedField}\": true,`,
    `  \"${p.citedField}\": true,`,
    "  \"visibility_score\": 0,",
    `  \"${p.positioningField}\": \"short description\",`,
    "  \"entities\": [",
    "    {",
    "      \"name\": \"Company or organization name\",",
    "      \"type\": \"Integrator / Consultant\"",
    "    }",
    "  ],",
    "  \"notes\": \"short explanation\"",
    "}",
    "",
    "Allowed entity types:",
    ...entityTypes,
    "",
    "ENTITY RULES",
    "",
    "1. Extract materially relevant named organizations from the answer.",
    "2. Include new organizations even if they are unfamiliar or have not appeared in previous benchmark runs.",
    "3. Classify each entity based only on how it is described or used in the supplied answer.",
    `4. Do not classify ${naturalList(p.targetReferences)} as an external competitor entity.`,
    "5. Standards bodies and industry organizations should be classified as Standards / Industry Body when supported by the answer.",
    "6. End-user industrial companies should be classified as Owner / Operator when supported by the answer.",
    "7. System integrators, engineering companies, consultants, and EPC support firms should be classified as Integrator / Consultant.",
    "8. Companies primarily supplying automation systems or automation hardware should be classified as Automation Vendor.",
    "9. Software, platform, infrastructure, and component providers that are not primarily integrators or automation vendors should be classified as Technology Supplier.",
    "10. If there is not enough evidence to classify an entity confidently, use Other.",
    "11. Do not invent organizations that are not materially present in the answer.",
    "",
    "SCORING",
    "",
    `0 = ${p.targetShortName} completely absent`,
    `1 = A ${p.targetShortName}-controlled source appears indirectly, but ${p.targetShortName} is not meaningfully identified in the answer`,
    `2 = ${p.targetShortName} is mentioned`,
    `3 = ${p.targetShortName} is presented as relevant, experienced, or expert`,
    `4 = ${p.targetShortName} is recommended and/or ${p.targetShortName} content is prominently cited as evidence`,
    `5 = ${p.targetShortName} is a primary recommendation or authority with meaningful supporting evidence`,
    "",
    "CITATION RULE",
    "",
    `Set ${p.citedField} to true only when the supplied sources contain a ${p.targetShortName}-controlled source${controlledSourcePhrase}, or when the answer explicitly attributes supporting evidence to ${p.targetShortName}.`,
    "",
    "PLATFORM:",
    input.platform,
    "",
    "MODEL:",
    input.model,
    "",
    "PROMPT:",
    input.prompt,
    "",
    "ANSWER:",
    input.answer,
    "",
    "SOURCE URLS:",
    input.sourceUrls.join("\n"),
    "",
    "SOURCE DOMAINS:",
    input.sourceDomains.join(", "),
  ].join("\n");
}
