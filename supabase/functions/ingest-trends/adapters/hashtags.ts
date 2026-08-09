// The seed hashtag list every TikTok adapter probes, attributed to the segment
// it feeds.
//
// This lives on its own because it is VIRL's configuration, not any vendor's.
// It began inside the EnsembleData adapter, which meant a second adapter could
// only reuse it by importing from the vendor it was replacing — a dependency
// pointing the wrong way. Moving it here is what lets an adapter be deleted
// without taking the segment coverage with it.
//
// Real estate is the launch segment so it gets the deepest coverage; every
// other segment gets 1–2 probes to keep niche_scores from being a real-estate
// monoculture. 22 tags = 22 billable calls, under every adapter's default cap.

export const HASHTAG_CONFIG: Array<{ tag: string; segment: string }> = [
  { tag: "realtorsoftiktok", segment: "real_estate" },
  { tag: "realestatetips", segment: "real_estate" },
  { tag: "listingtour", segment: "real_estate" },
  { tag: "openhouse", segment: "real_estate" },
  { tag: "firsttimehomebuyer", segment: "real_estate" },
  { tag: "justlisted", segment: "real_estate" },
  { tag: "lifecoach", segment: "coach" },
  { tag: "businesscoach", segment: "coach" },
  { tag: "contentcreator", segment: "creator" },
  { tag: "creatortips", segment: "creator" },
  { tag: "personalbrand", segment: "personal_brand" },
  { tag: "thoughtleadership", segment: "personal_brand" },
  { tag: "smallbusinesscheck", segment: "small_business" },
  { tag: "smallbusinessowner", segment: "small_business" },
  { tag: "fittok", segment: "fitness" },
  { tag: "personaltrainer", segment: "fitness" },
  { tag: "doctorsoftiktok", segment: "healthcare" },
  { tag: "nursesoftiktok", segment: "healthcare" },
  { tag: "beautytok", segment: "beauty" },
  { tag: "estheticiantok", segment: "beauty" },
  { tag: "hairstylist", segment: "hair" },
  { tag: "hairtok", segment: "hair" },
];
