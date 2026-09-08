// The seed search terms the YouTube adapter probes, attributed to the segment
// each feeds. VIRL's configuration, not the vendor's — the same reason
// hashtags.ts lives apart from the TikTok adapters.
//
// These are SEARCH QUERIES, not hashtags, because YouTube is not a hashtag
// platform: demand shows up as what people type into the search box, and the
// research frame for YouTube (trends-research.js) already treats "topics or
// questions getting outsized search and view demand" as the signal. Sampling
// the most-viewed videos published this week for each query, twice a week, is
// the measured version of that same question.
//
// Budget: one query costs a search.list call (100 quota units) plus one
// videos.list call (1 unit). 21 queries ≈ 2,100 units a run, two runs a week,
// against a free daily quota of 10,000. Nothing here is billable.
//
// Real estate is the launch segment so it gets the deepest coverage; every
// other segment gets 2 so niche_scores on YouTube rows are not a real-estate
// monoculture. Add a term the day a segment's creators say a query matters to
// them, and keep the total under MAX_SEARCHES in youtube.ts.

export const YOUTUBE_SEARCH_CONFIG: Array<{ term: string; segment: string }> = [
  { term: "first time home buyer tips", segment: "real_estate" },
  { term: "house tour", segment: "real_estate" },
  { term: "real estate agent day in the life", segment: "real_estate" },
  { term: "life coach", segment: "coach" },
  { term: "business coaching", segment: "coach" },
  { term: "content creator tips", segment: "creator" },
  { term: "how to grow on youtube", segment: "creator" },
  { term: "personal branding", segment: "personal_brand" },
  { term: "thought leadership", segment: "personal_brand" },
  { term: "small business owner", segment: "small_business" },
  { term: "small business tips", segment: "small_business" },
  { term: "personal trainer workout", segment: "fitness" },
  { term: "fitness coach", segment: "fitness" },
  { term: "doctor explains", segment: "healthcare" },
  { term: "nurse day in the life", segment: "healthcare" },
  { term: "esthetician", segment: "beauty" },
  { term: "skincare routine", segment: "beauty" },
  { term: "hair stylist", segment: "hair" },
  { term: "hair transformation", segment: "hair" },
];
