import { buildVisibilityScorerPrompt, type VisibilityScorerPromptProfile } from "@ai-visibility/scoring";

const profile: VisibilityScorerPromptProfile = {
  targetDisplayName: "Collaborative Systems Integration",
  targetShortName: "CSI",
  targetReferences: [
    "Collaborative Systems Integration",
    "CSI Automation",
    "csi-automation.com",
    "Collaborative Systems Integration (CSI)",
  ],
  mentionedField: "csi_mentioned",
  citedField: "csi_cited",
  positioningField: "csi_positioning",
  allowedEntityTypes: [
    "Integrator / Consultant",
    "Automation Vendor",
    "Technology Supplier",
    "Owner / Operator",
    "Standards / Industry Body",
    "Other",
  ],
  controlledSourceExample: "csi-automation.com",
};

function assertIncludes(text: string, expected: string, label: string): void {
  if (!text.includes(expected)) throw new Error(`${label}: missing expected production text: ${expected}`);
  console.log(`${label}: passed`);
}

function assertOrdered(text: string, values: string[], label: string): void {
  let cursor = -1;
  for (const value of values) {
    const index = text.indexOf(value, cursor + 1);
    if (index < 0 || index < cursor) throw new Error(`${label}: expected ordered text not found: ${value}`);
    cursor = index;
  }
  console.log(`${label}: passed`);
}

const scoringPrompt = buildVisibilityScorerPrompt({
  profile,
  platform: "OpenAI",
  model: "gpt-5.6-luna",
  prompt: "Which companies can help implement Open Process Automation?",
  answer: "Example benchmark answer.",
  sourceUrls: ["https://csi-automation.com/example", "https://www.opengroup.org/example"],
  sourceDomains: ["csi-automation.com", "opengroup.org"],
});

assertIncludes(scoringPrompt, "You are evaluating AI visibility for Collaborative Systems Integration.", "Target identity");
assertIncludes(scoringPrompt, "Evaluate ONLY the supplied benchmark answer and sources.\nDo not use outside knowledge.", "Evidence boundary");
assertIncludes(scoringPrompt, '  "csi_mentioned": true,', "Mention field");
assertIncludes(scoringPrompt, '  "csi_cited": true,', "Citation field");
assertIncludes(scoringPrompt, '  "visibility_score": 0,', "Visibility score field");
assertIncludes(scoringPrompt, '  "csi_positioning": "short description",', "Positioning field");
assertIncludes(scoringPrompt, "4. Do not classify Collaborative Systems Integration, CSI Automation, csi-automation.com, or Collaborative Systems Integration (CSI) as an external competitor entity.", "CSI exclusion rule");
assertIncludes(scoringPrompt, "0 = CSI completely absent", "Score 0 rule");
assertIncludes(scoringPrompt, "1 = A CSI-controlled source appears indirectly, but CSI is not meaningfully identified in the answer", "Score 1 rule");
assertIncludes(scoringPrompt, "2 = CSI is mentioned", "Score 2 rule");
assertIncludes(scoringPrompt, "3 = CSI is presented as relevant, experienced, or expert", "Score 3 rule");
assertIncludes(scoringPrompt, "4 = CSI is recommended and/or CSI content is prominently cited as evidence", "Score 4 rule");
assertIncludes(scoringPrompt, "5 = CSI is a primary recommendation or authority with meaningful supporting evidence", "Score 5 rule");
assertIncludes(scoringPrompt, "Set csi_cited to true only when the supplied sources contain a CSI-controlled source such as csi-automation.com, or when the answer explicitly attributes supporting evidence to CSI.", "Citation rule");
assertOrdered(scoringPrompt, ["PLATFORM:\nOpenAI", "MODEL:\ngpt-5.6-luna", "PROMPT:\nWhich companies can help implement Open Process Automation?", "ANSWER:\nExample benchmark answer.", "SOURCE URLS:\nhttps://csi-automation.com/example\nhttps://www.opengroup.org/example", "SOURCE DOMAINS:\ncsi-automation.com, opengroup.org"], "Input section order");

console.log("CSI production scorer prompt parity validation passed.");
console.log("No database writes or provider/model API calls were made.");
