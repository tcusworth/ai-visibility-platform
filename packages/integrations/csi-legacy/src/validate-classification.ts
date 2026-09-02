import { normalizeScorerClassification } from "@ai-visibility/scoring";

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertIncludes(actual: string, expected: string, label: string): void {
  if (!actual.includes(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(actual)} to include ${JSON.stringify(expected)}`);
  }
}

const common = {
  sourceDomains: [] as string[],
  sourceUrls: [] as string[],
  ownedDomains: ["csi-automation.com"],
  promptWeight: 3,
  scorerVersion: "csi-production-scorer-v1",
};

function main(): void {
  const standard = normalizeScorerClassification({
    ...common,
    rawText: JSON.stringify({
      csi_mentioned: true,
      csi_cited: false,
      visibility_score: 4,
      csi_positioning: "CSI is recommended as a relevant integrator.",
      entities: [{ name: "Yokogawa", type: "Automation Vendor" }],
      notes: "CSI is recommended in the answer.",
    }),
  });

  assertEqual(standard.targetMentioned, true, "Standard target mention");
  assertEqual(standard.targetCited, false, "Standard target citation");
  assertEqual(standard.visibilityScore, 4, "Standard visibility score");
  assertEqual(standard.targetRecommended, true, "Recommendation threshold");
  assertEqual(standard.weightedScore, 12, "Weighted score");
  assertEqual(standard.entities.length, 1, "Entity count");
  assertEqual(standard.entities[0]?.name, "Yokogawa", "Entity name");
  assertEqual(standard.parseFailed, false, "Standard parse status");

  const citationOverride = normalizeScorerClassification({
    ...common,
    sourceDomains: ["docs.csi-automation.com"],
    rawText: JSON.stringify({
      csi_mentioned: true,
      csi_cited: false,
      visibility_score: 2,
      csi_positioning: "CSI is mentioned.",
      entities: [],
      notes: "",
    }),
  });

  assertEqual(citationOverride.targetCited, true, "Owned-domain citation override");
  assertEqual(citationOverride.targetRecommended, false, "Score 2 is not recommended");

  const urlCitationOverride = normalizeScorerClassification({
    ...common,
    sourceUrls: ["https://www.csi-automation.com/resources/example"],
    rawText: JSON.stringify({
      csi_mentioned: false,
      csi_cited: false,
      visibility_score: 1,
      entities: [],
    }),
  });

  assertEqual(urlCitationOverride.targetCited, true, "Owned URL citation override");

  const upperClamp = normalizeScorerClassification({
    ...common,
    promptWeight: 2,
    rawText: JSON.stringify({
      csi_mentioned: true,
      csi_cited: true,
      visibility_score: 9,
      entities: [],
    }),
  });

  assertEqual(upperClamp.visibilityScore, 5, "Upper score clamp");
  assertEqual(upperClamp.weightedScore, 10, "Upper-clamped weighted score");
  assertEqual(upperClamp.targetRecommended, true, "Upper-clamped recommendation");

  const lowerClamp = normalizeScorerClassification({
    ...common,
    rawText: JSON.stringify({
      csi_mentioned: false,
      csi_cited: false,
      visibility_score: -3,
      entities: [],
    }),
  });

  assertEqual(lowerClamp.visibilityScore, 0, "Lower score clamp");
  assertEqual(lowerClamp.weightedScore, 0, "Lower-clamped weighted score");

  const fenced = normalizeScorerClassification({
    ...common,
    rawText: "```json\n{\"csi_mentioned\":true,\"csi_cited\":false,\"visibility_score\":3,\"entities\":[]}\n```",
  });

  assertEqual(fenced.parseFailed, false, "Fenced JSON parse");
  assertEqual(fenced.visibilityScore, 3, "Fenced JSON score");

  const malformed = normalizeScorerClassification({
    ...common,
    sourceDomains: ["csi-automation.com"],
    rawText: "not valid json",
  });

  assertEqual(malformed.parseFailed, true, "Malformed JSON parse status");
  assertEqual(malformed.targetMentioned, false, "Malformed JSON mention fallback");
  assertEqual(malformed.targetCited, true, "Malformed JSON deterministic citation override");
  assertEqual(malformed.visibilityScore, 0, "Malformed JSON score fallback");
  assertEqual(malformed.targetRecommended, false, "Malformed JSON recommendation fallback");
  assertEqual(malformed.weightedScore, 0, "Malformed JSON weighted score fallback");
  assertEqual(malformed.entities.length, 0, "Malformed JSON entity fallback");
  assertIncludes(malformed.notes, "Scoring JSON parse failed:", "Malformed JSON notes");

  console.log("Standard score 4 -> recommendation: passed");
  console.log("Owned-domain citation override: passed");
  console.log("Owned-URL citation override: passed");
  console.log("Visibility score clamp 0-5: passed");
  console.log("Weighted score = visibility score × prompt weight: passed");
  console.log("Fenced JSON parsing: passed");
  console.log("Malformed JSON fail-closed behavior: passed");
  console.log("CSI production scorer normalization parity validation passed.");
  console.log("No database writes or provider/model API calls were made.");
}

main();
