# PR 0 copy changes

Every user-facing string changed in PR 0, grouped by file. `VIRL-app/` paths are in the marketing repo.

## index.html

- Before: content="VIRL is the first AI content strategist. It learns your voice and maps a full week of social content in about 60 seconds. 14-day free trial, no card."
  After: content="VIRL is the first AI content strategist. It plans your week and writes every post in your voice, in about 60 seconds. 14-day free trial, no card."

- Before: content="The first AI content strategist. VIRL learns your voice and maps a full week of social content in about 60 seconds. 14-day free trial, no card."
  After: content="The first AI content strategist. VIRL plans your week and writes every post in your voice, in about 60 seconds. 14-day free trial, no card."

- Before: That's the hardest part. Save what you love, log what you post — VIRL learns from every move and gets sharper every week.
  After: That's the hardest part. Save what you love and log what you post. With your permission, VIRL uses both when it writes your next plan.

- Before: VIRL learns from how you use the app so generations sound more like you. Personalization is on by default — you can turn off the whole thing, or any individual source, at any time.
  After: VIRL can use your edits, saved posts, logged results and public posts when it writes for you. Personalization is on by default; turn off the whole thing, or any single source, at any time.

- Before: ? "I'm learning from the sources you've enabled below."               : "I'm not learning from any source right now. Your generations will be less tailored to your voice."
  After: ? "I'm using the sources you've enabled below."               : "I'm not using any of these sources right now. Your generations will be less tailored to your voice."

- Before: Sources VIRL learns from
  After: Sources VIRL can use

- Before: {"When you mark a plan card as posted and log a number — even just views — it lands here, grouped by week. I read these to learn what's actually working for your audience and sharpen next week's plan.
  After: {"When you mark a plan card as posted and log a number — even just views — it lands here, grouped by week. If you've allowed it, I read these when I write next week's plan."}

- Before: Fill in what you remember. I use these numbers to make next week's plan sharper.
  After: Fill in what you remember. If you've allowed it, I use these numbers in next week's plan.

- Before: <div style={{fontFamily:"'Italiana',serif",fontSize:17,color:B.navy,lineHeight:1.2,marginBottom:4}}>Learning from your Vault.</div>
  After: <div style={{fontFamily:"'Italiana',serif",fontSize:17,color:B.navy,lineHeight:1.2,marginBottom:4}}>Using your Vault.</div>

- Before: <SherpaTip>Everything you've saved from your plans and captions lives here. Your Vault grows over time into a personal content library built around your voice.</SherpaTip>
  After: <SherpaTip>Everything you've saved from your plans and captions lives here. Your saved posts are also voice references when you allow it.</SherpaTip>

## api/_lib/email-templates.js

- Before: <li>Log results on every post — VIRL learns what's working for <em>your</em> audience.</li>
  After: <li>Log results on every post — with your permission, VIRL uses them in next week's plan.</li>

- Before: const headline = "Your week's ready when you are.";
  After: const headline = "New week. Want your plan?";

- Before: subject: "Your week's ready — here's my thinking",
  After: subject: "New week — ready to plan it?",

- Before: <li><strong>Save the posts you love</strong> to your Vault — I learn your taste from what you save and weight similar styles in next week's plan.</li>
  After: <li><strong>Save the posts you love</strong> to your Vault — with your permission, I use them as voice references in next week's plan.</li>

- Before: <li><strong>Log results after you post</strong> (views, likes, saves). That's how I learn what's actually working for <em>your</em> audience, not generic best practices.</li>
  After: <li><strong>Log results after you post</strong> (views, likes, saves). With your permission, I read them when I plan your next week.</li>

- Before: <p style="margin:0 0 12px">Why it's worth it: I learn what's working for <em>your</em> audience from these numbers. Tell me how it landed and next week's plan gets sharper in ways generic best practic
  After: <p style="margin:0 0 12px">Why it's worth it: with your permission, I read these numbers when I write next week's plan, so it leans on what worked for <em>your</em> audience.</p>

- Before: \n\nTell me how they landed and next week's plan gets sharper.\n\n
  After: \n\nTell me how they landed and I'll use it in next week's plan.\n\n

- Before: subject: count === 1 ? "Tomorrow's post is ready to go" : `Tomorrow's ${count} posts are ready to go`,
  After: subject: count === 1 ? "Tomorrow's post, from your plan" : `Tomorrow's ${count} posts, from your plan`,

- Before: still need${Number(unloggedCount) === 1 ? "s" : ""} results logged — that's how next week's plan gets sharper.</p>`;
  After: still need${Number(unloggedCount) === 1 ? "s" : ""} results logged — I use them in next week's plan when you allow it.</p>`;

- Before: the saved-to-vault loop is where I actually start working. Once I have 3-5 saved posts to learn from, the next plan starts feeling pointed.
  After: the saved-to-vault loop is where I actually start working. Once I have 3-5 saved posts to reference, the next plan starts feeling pointed.

- Before: <li><strong>Log results</strong> on anything you've actually posted. That's how I learn what's landing for <em>your</em> audience, not generic best practices.</li>
  After: <li><strong>Log results</strong> on anything you've actually posted. With your permission, I read them when I plan your next week.</li>

- Before: subject: "How I get sharper after this week",
  After: subject: "What makes week two better",

- Before: save 3 posts to your vault, and log results on anything you've posted — that's how I get sharper.
  After: save 3 posts to your vault, and log results on anything you've posted — I use both in your next plan when you allow it.

## VIRL-app/beauty/index.html

- Before: <h3>It learns your voice &ndash; the real one.</h3>
  After: <h3>It writes in your voice &ndash; the real one.</h3>

- Before: <h3>It gets sharper from what works.</h3>
  After: <h3>It plans from what worked.</h3>

## VIRL-app/small-business/index.html

- Before: <h3>It learns your voice &ndash; the real one.</h3>
  After: <h3>It writes in your voice &ndash; the real one.</h3>

- Before: <h3>It gets sharper from what works.</h3>
  After: <h3>It plans from what worked.</h3>

## VIRL-app/personal-brands/index.html

- Before: <h3>It learns your voice &ndash; the real one.</h3>
  After: <h3>It writes in your voice &ndash; the real one.</h3>

- Before: <h3>It gets sharper from what works.</h3>
  After: <h3>It plans from what worked.</h3>

## VIRL-app/hair-stylists/index.html

- Before: <h3>It learns your voice &ndash; the real one.</h3>
  After: <h3>It writes in your voice &ndash; the real one.</h3>

- Before: <h3>It gets sharper from what works.</h3>
  After: <h3>It plans from what worked.</h3>

## VIRL-app/coaches/index.html

- Before: <h3>It learns your voice &ndash; the real one.</h3>
  After: <h3>It writes in your voice &ndash; the real one.</h3>

- Before: <h3>It gets sharper from what works.</h3>
  After: <h3>It plans from what worked.</h3>

## VIRL-app/real-estate/index.html

- Before: <h3>It learns your voice &ndash; the real one.</h3>
  After: <h3>It writes in your voice &ndash; the real one.</h3>

- Before: <h3>It gets sharper from what works.</h3>
  After: <h3>It plans from what worked.</h3>

## VIRL-app/healthcare/index.html

- Before: <h3>It learns your voice &ndash; the real one.</h3>
  After: <h3>It writes in your voice &ndash; the real one.</h3>

- Before: <h3>It gets sharper from what works.</h3>
  After: <h3>It plans from what worked.</h3>

## VIRL-app/fitness/index.html

- Before: <h3>It learns your voice &ndash; the real one.</h3>
  After: <h3>It writes in your voice &ndash; the real one.</h3>

- Before: <h3>It gets sharper from what works.</h3>
  After: <h3>It plans from what worked.</h3>

## VIRL-app/creators/index.html

- Before: <h3>It learns your voice &ndash; the real one.</h3>
  After: <h3>It writes in your voice &ndash; the real one.</h3>

## VIRL-app/beauty/index.html

- Before: not a generic spa caption, and every edit teaches it.
  After: not a generic spa caption. With your permission, your edits become voice references too.

## VIRL-app/creators/index.html

- Before: <h3>It learns from what you post.</h3>
  After: <h3>It plans from what you post.</h3>

- Before: <p>Tell VIRL how posts performed and next week&rsquo;s plan gets sharper. The goal isn&rsquo;t a viral fluke.
  After: <p>Tell VIRL how posts performed and, with your permission, next week&rsquo;s plan uses it. The goal isn&rsquo;t a viral fluke.

- Before: VIRL learns from samples of your real writing and a no-go list of things you&rsquo;d never say, and it keeps learning from every edit you make to a draft.
  After: VIRL writes from samples of your real writing and a no-go list of things you&rsquo;d never say, and, with your permission, from the edits you make to drafts.

## VIRL-app/index.html

- Before: "description":"AI content strategist that plans your content, writes it in your specific voice, and helps you show up consistently. Not another AI writer."
  After: "description":"AI content strategist that plans your content, writes it in your specific voice, and helps you show up consistently. Not another AI writer."

- Before: VIRL is a strategist – it plans content with intention, learns your specific voice, and builds output structured for the platforms and formats you actually use.
  After: VIRL is a strategist – it plans content with intention, writes in your specific voice, and builds output structured for the platforms and formats you actually use.

- Before: VIRL is a strategist. It plans content with intention, learns your specific voice, and builds output structured for the platforms and formats you actually use.
  After: VIRL is a strategist. It plans content with intention, writes in your specific voice, and builds output structured for the platforms and formats you actually use.

- Before: <p class="hiw-step-title">Log results so next week gets sharper</p>
  After: <p class="hiw-step-title">Log results so next week builds on them</p>

- Before: VIRL learns from your edits, saves, and results, so every week sounds more like you and works a little better.
  After: With your permission, VIRL uses your edits, saves, and results when it writes the next week.

- Before: <span>Format-aware content (video, carousel, story, long-form)</span>
  After: <span>Format-aware content (video, carousel, story, text posts)</span>

- Before: VIRL adapts content to feed posts, carousels, Reels, Stories, LinkedIn long-form, document carousels, threads, and Story sequences.
  After: VIRL adapts content to feed posts, carousels, Reels, Stories, LinkedIn text posts, document carousels, threads, and Story sequences.

- Before: "featureList":["Strategic weekly content planning","Voice-matched output across all formats","Format-aware content for video, carousel, story, and long-form"
  After: "featureList":["Strategic weekly content planning","Voice-matched output across all formats","Format-aware content for video, carousel, story, and text posts"

## VIRL-app/blog/scheduler-or-strategist/index.html

- Before: <tr><th>Learns from results</th><td>Reports numbers</td><td class="virl">Sharpens next week&rsquo;s plan</td></tr>
  After: <tr><th>Uses your results</th><td>Reports numbers</td><td class="virl">Reads them for next week&rsquo;s plan</td></tr>

## VIRL-app/blog/chatgpt-for-social-media/index.html

- Before: <tr><th>Your voice</th><td>Re-prompt every time</td><td class="virl">Learned from a voice profile</td></tr>
  After: <tr><th>Your voice</th><td>Re-prompt every time</td><td class="virl">Written from a voice profile</td></tr>

- Before: <tr><th>Learns from results</th><td>No feedback loop</td><td class="virl">Sharpens each week</td></tr>
  After: <tr><th>Uses your results</th><td>No feedback loop</td><td class="virl">Reads them for next week</td></tr>

- Before: remembers your history, holds your voice, and learns from results, the parts ChatGPT leaves to you.
  After: remembers your history, holds your voice, and reads your results, the parts ChatGPT leaves to you.

## Removed outright

- Thumbs-down reason chips: "Too formal" / "Not my words" / "Wrong energy" and the confirmation "Got it — your next drafts will account for this" (index.html, RatingButtons).
- The Posts tab: "VIRL Posts", "Long-form, still in your voice.", "For the LinkedIn post you've been meaning to write, or the blog post that's been sitting in your drafts…", "Writing in {name}'s voice — tuned to long-form."
- Plan-card action "Write Full Post" / "View Full Post" and the LinkedIn long-post modal.
- Admin: "Why the thumbs-downs" panel and the "N unexplained" badge.

## Renamed

- Plan setup pill "Long-form post" → "Text post" (old saved value still resolves).
- LinkedIn format option "Long-form Text Posts" → "Text Posts".
- Niche picker: 17 niches → "Real Estate", "Small Business", "Creators & Personal Brands".
