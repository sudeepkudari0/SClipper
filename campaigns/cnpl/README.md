# CNPL Pickleball Campaign

This folder contains the campaign profile (`profile.yaml`) and assets for the **CNPL** paid clipping campaign.

Drop the official CNPL watermark icon at `campaigns/cnpl/assets/cnpl_icon.png`.

## Rules Encoded in `profile.yaml`

- **Hashtags**: Must include `#CNPLclips` (case-sensitive, exactly as written). Up to 6 hashtags total (`#pickleball` added as extra).
- **Mentions**: Must tag `@officialcnpl`.
- **Format**: Vertical `9:16` (`1080x1920`), `30` fps, duration between `8` and `60` seconds (target `12-25` s).
- **Reframing**: Auto-crop without letterboxing or blurred background fill (`allowBlurFill: false`).
- **Watermark**: Visible for the entire clip (`fullDuration: true`) in `bottom-left` corner (`marginPct: { x: 4, bottom: 14 }`, `widthPct: 14`) to stay clear of platform UI and avoid covering the ball.
- **Audio**: Keep original audio normalized to `-14` LUFS. **No baked-in music** (`bans.bakedMusic: true`) — add in-app sounds only during manual upload.
- **AI Restrictions**: No AI voiceover (`bans.aiVoiceover: true`) and no AI-generated footage (`bans.aiFootage: true`).
- **Tone & Accuracy**: Positive, factual, energetic. No mocking players, officials, or injuries. No fake scores, invented stats, or misleading titles.
- **Posting Windows**: `18:00–21:00 America/Toronto` (converted to local time on export).

## Rules the Tool Cannot Verify

The following campaign requirements are outside the scope of automated local checks and must be verified manually:

1. **Official CNPL footage only**: The tool assumes files placed in `sources/cnpl` (or fetched via `sources.fetch`) are official CNPL footage.
2. **One account per platform**: You must ensure you only post from a single authorized account per platform (TikTok, Instagram, YouTube).
3. **Account age / standing**: Platform account eligibility requirements cannot be checked locally.
4. **Audience geography proof**: Sending analytics screenshots proving audience geography is a manual step.
5. **Uniqueness vs. other clippers**: The tool cannot check whether another clipper has already posted the exact same rally.
