window.CSI_VISIBILITY_DATA = {
  generatedAt: "2026-09-16T15:30:00Z",
  runs: [
    {
      id: "2026-09-15-full100-v1",
      label: "September 15 full benchmark",
      date: "2026-09-15",
      status: "complete",
      observations: 400,
      expectedObservations: 400,
      attempts: 400,
      promptCount: 100,
      visibilityIndex: 36.325,
      mentionShare: 42.5,
      citationShare: 59.25,
      recommendationShare: 20.75,
      ownedSourceShare: 58.5,
      authorityShare: 8.25,
      authorityMentions: 33,
      providerSelectionAuthorityShare: 21.55,
      providers: [
        { name: "OpenAI", index: 19.9, mentions: 24, citations: 20, recommendations: 17, authority: 7, authorityShare: 7, averageAuthority: 2.29 },
        { name: "Gemini", index: 24.5, mentions: 27, citations: 61, recommendations: 4, authority: 6, authorityShare: 6, averageAuthority: 2.00 },
        { name: "Perplexity", index: 76.4, mentions: 92, citations: 99, recommendations: 55, authority: 14, authorityShare: 14, averageAuthority: 2.21 },
        { name: "Claude", index: 24.5, mentions: 27, citations: 57, recommendations: 7, authority: 6, authorityShare: 6, averageAuthority: 2.50 }
      ]
    },
    {
      id: "2026-08-27-full100-v1",
      label: "August 27 baseline",
      date: "2026-08-27",
      status: "complete",
      observations: 400,
      expectedObservations: 400,
      attempts: 400,
      promptCount: 100,
      visibilityIndex: 33.525,
      mentionShare: 40.75,
      citationShare: 51.25,
      recommendationShare: 19.25,
      ownedSourceShare: 50.5,
      authorityShare: null,
      authorityMentions: null,
      providerSelectionAuthorityShare: null,
      providers: [
        { name: "OpenAI", index: 20.5, mentions: 24, citations: 19, recommendations: 19 },
        { name: "Gemini", index: 23.8, mentions: 25, citations: 60, recommendations: 5 },
        { name: "Perplexity", index: 63.1, mentions: 76, citations: 80, recommendations: 46 },
        { name: "Claude", index: 26.7, mentions: 38, citations: 46, recommendations: 7 }
      ]
    },
    {
      id: "2026-09-03-shadow5-r2",
      label: "September 3 shadow validation",
      date: "2026-09-03",
      status: "complete",
      observations: 20,
      expectedObservations: 20,
      attempts: 20,
      promptCount: 5,
      visibilityIndex: 46.6,
      mentionShare: 55,
      citationShare: 65,
      recommendationShare: 30,
      ownedSourceShare: null,
      authorityShare: null,
      authorityMentions: null,
      providerSelectionAuthorityShare: null,
      providers: [
        { name: "OpenAI", index: 40.4, mentions: 40, citations: 40, recommendations: 40 },
        { name: "Gemini", index: 32.2, mentions: 40, citations: 80, recommendations: 0 },
        { name: "Perplexity", index: 88.7, mentions: 100, citations: 100, recommendations: 80 },
        { name: "Claude", index: 25.1, mentions: 40, citations: 40, recommendations: 0 }
      ]
    }
  ],
  categories: ["Architecture", "Business Case", "EPC", "Integration", "Migration", "Procurement", "Provider Selection", "Standards", "Strategy", "Training"],
  methodology: {
    providers: ["OpenAI", "Gemini", "Perplexity", "Claude"],
    scorer: "CSI production scorer",
    recommendationThreshold: 4,
    logicalObservation: "One prompt × one provider",
    aggregation: "Successful observations only; overall index is the mean of rounded platform indices"
  }
};
