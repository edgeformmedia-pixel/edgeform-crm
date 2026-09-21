// The pay explainer from CONTRACT.md §9, word for word. The public application page, the invite email
// and the CRM's preview all render it from here so nobody writes their own version.
// No imports: the admin UI loads this same file as a module (home/index.html).

const PLATFORM_NAMES = { tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube' };

/** 150 → "$1.50" */
export const money = (cents) => '$' + (Number(cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 500 → "5%", 550 → "5.5%" */
export const percent = (bps) => `${Number(bps || 0) / 100}%`;

/** ['tiktok','instagram','youtube'] → "TikTok, Instagram or YouTube" */
export function platformList(platforms) {
  const names = (platforms || []).map(p => PLATFORM_NAMES[p] || p);
  if (names.length <= 1) return names[0] || '';
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

/** The §9 variables from a PublicCampaign-shaped object (snake_case). */
export function payVariables(c) {
  return {
    starting_cpm: money(c.starting_cpm_rate_cents),
    team_bonus: percent(c.team_bonus_bps),
    brand: c.brand_name || c.name,
    platforms: platformList(c.platforms_allowed),
    min_views: c.min_views_to_qualify ?? null,
    referrer_first: c.referrer_first_name ?? null
  };
}

/**
 * Returns [{ heading, body }] — the three paragraphs. The heading is the bold lead; for the first
 * paragraph it's a title above the text, for the others it opens the paragraph.
 * A 0% team bonus drops the third paragraph rather than advertising "a 0% team bonus".
 */
export function payExplainer(c) {
  const v = payVariables(c);
  const parts = [
    {
      heading: 'How you get paid',
      body: `You post about ${v.brand} on ${v.platforms}. Every Sunday we count the new views each of your videos ` +
        `picked up that week, and you're paid ${v.starting_cpm} for every 1,000 of them. A video keeps earning ` +
        `every week for as long as the campaign is running — there's no cut-off date and no limit on how many ` +
        `videos you post.`
    },
    {
      heading: `${v.starting_cpm} per 1,000 views is where everyone starts.`,
      body: `As your videos deliver, your rate goes ` +
        `up with your level — Rookie, General, Master, Top Creator. Levels are set by Edgeform across every ` +
        `campaign you're on, not campaign by campaign, so a raise you earn here follows you to the next one.`
    }
  ];
  if (Number(c.team_bonus_bps) > 0) {
    parts.push({
      heading: `Bring other creators in and you earn a ${v.team_bonus} team bonus`,
      body: `on what they're paid for their own ` +
        `views, for as long as they're posting. Edgeform pays it on top of their pay — their rate is never ` +
        `reduced to fund yours, and you earn it on their views, never on them signing up. There's no fee to ` +
        `apply and nothing to buy, now or later.`
    });
  }
  return parts;
}

/** Plain text, for email. */
export function payExplainerText(c) {
  return payExplainer(c).map((p, i) => (i === 0 ? `${p.heading}\n${p.body}` : `${p.heading} ${p.body}`)).join('\n\n');
}
