export default function HomePage() {
  return (
    <main className="page" id="top">
      <header className="site-header">
        <span className="brand-mark" aria-hidden="true">BH</span>
        <span className="brand-name">BrawlHub</span>
      </header>

      <section className="hero">
        <p className="eyebrow">Brawl Stars club insights</p>
        <h1>Your club, clearly.</h1>
        <p className="lede">
          BrawlHub brings club and player information together in one calm place,
          so you can follow your community instead of chasing scattered data.
        </p>

        <div className="actions">
          <a className="button button-primary" href="/api/health">
            Service health
          </a>
          <a className="button button-secondary" href="#documentation">
            Documentation
          </a>
        </div>

        <p className="notice">
          <strong>Nothing to show yet.</strong> Data appears here only after clubs
          have been registered and synced. Until then, no club, player, or match
          figures are displayed.
        </p>
      </section>

      <section className="docs" id="documentation" aria-labelledby="docs-title">
        <h2 id="docs-title">Documentation</h2>

        <div className="doc-grid">
          <article className="doc-card">
            <h3>Getting started</h3>
            <p>
              Configure the environment variables from <code>.env.example</code>,
              register a club, and run a sync. Once data lands in the database,
              this site will reflect it.
            </p>
          </article>

          <article className="doc-card">
            <h3>Health checks</h3>
            <p>
              The <a href="/api/health">health endpoint</a> reports whether the
              database is reachable and which integrations are configured. It
              never returns secret values.
            </p>
          </article>

          <article className="doc-card">
            <h3>Privacy</h3>
            <p>
              Service-role credentials stay on the server and are used only for
              trusted jobs. Browser requests use a limited, user-scoped client.
            </p>
          </article>
        </div>
      </section>

      <footer className="site-footer">
        <span>BrawlHub</span>
        <span className="footer-divider" aria-hidden="true">·</span>
        <a href="#top">Back to top</a>
      </footer>
    </main>
  );
}
