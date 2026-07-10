-- [TRIAL-TRENDS] Free users get 2 live-trends plans per weekly cycle
-- (scans/captions stay at 1). Default covers new rows; the lazy weekly
-- reset in api/chat.js writes 2 for existing rows on their next cycle.
alter table public.credits alter column fresh_trends_plan_remaining set default 2;
