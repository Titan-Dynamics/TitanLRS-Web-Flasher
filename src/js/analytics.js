// PostHog project API key (phc_...). A public, write-only key: safe to ship in the site bundle.
const POSTHOG_KEY = 'phc_P6BPT83SMh6v3PW0sln5YJUI4ihN9GqMMBZnv5BQkIs'
// PostHog Cloud region of the project: US 'https://us.i.posthog.com', EU 'https://eu.i.posthog.com'.
const POSTHOG_HOST = 'https://us.i.posthog.com'

/**
 * Start PostHog (pageviews + autocapture). posthog-js is loaded on demand (its own chunk,
 * ~130 kB gzipped), so it never delays the app starting.
 */
export async function initAnalytics() {
    const {default: posthog} = await import('posthog-js')
    posthog.init(POSTHOG_KEY, {
        api_host: POSTHOG_HOST,
        // Pinned set of PostHog's recommended settings, so a library update can't change behaviour.
        defaults: '2026-08-30',
        // Anonymous visitors only; no person profiles unless someone is identified.
        person_profiles: 'identified_only',
    })
}
