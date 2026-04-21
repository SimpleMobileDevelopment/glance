# glance

A single-page HTML dashboard for what you need to look at before you start coding. Runs locally, renders a grid of cards from a handful of pluggable widgets (PRs, Linear, CI, crash reports, RSS digests with LLM triage, release deadlines, etc.), and rebuilds on a 15-minute timer.

No service to deploy, no database, no account. One `project.json`, one `.env`, one static HTML file in `dist/`.

## Quickstart

Requires Node 22.7+.

```bash
npm install
cp .env.example .env        # then fill in keys for whichever widgets you enable
npm run serve               # http://127.0.0.1:4321 + settings UI at /settings
```

Or for a one-shot build without the server:

```bash
npm run start               # writes dist/index.html and exits
```

By default no widgets are enabled. Open the settings page (`/settings`) to toggle widgets on, or edit `project.json` directly.

## Widgets

Each widget is a module in `src/widgets/` that reads config from `project.json` and returns an HTML card. Toggle widgets on in the settings UI or by adding their key under `widgets` in `project.json`.

| id            | what it shows                                                                         | what it needs                                                                  |
|---------------|----------------------------------------------------------------------------------------|--------------------------------------------------------------------------------|
| `prs`         | GitHub PRs you've opened + ones awaiting your review                                   | `GITHUB_TOKEN` (classic PAT with `repo` + `read:user`, or a fine-grained PAT)  |
| `linear`      | Linear issues assigned to you + unread inbox (mentions, comments, PR events)           | `LINEAR_API_KEY` (personal key from linear.app/settings/api)                   |
| `ci`          | Latest GitHub Actions workflow runs for configured repos and branches                  | `GITHUB_TOKEN`; repos/branches/workflow in `project.json`                      |
| `crashlytics` | Top Firebase Crashlytics issues over a lookback window (via BigQuery export)           | Google OAuth (Firebase + BigQuery scopes); Firebase + GCP project IDs          |
| `playConsole` | Google Play Console release status for your package                                    | Google OAuth (Play Developer scope); package name                              |
| `gitStatus`   | Uncommitted changes, branch status for one or more local checkouts                     | Absolute paths in `project.json`                                               |
| `drift`       | Gradle version catalog dependencies that lag behind Maven Central latest               | Path(s) to `gradle/libs.versions.toml`                                         |
| `feed`        | Merged RSS feed (blogs, release notes, newsletters)                                    | Feed URLs in `project.json`                                                    |
| `alerts`      | LLM-triaged action items surfaced from the same feeds as `feed`                        | `ANTHROPIC_API_KEY`; `feed` widget configured; a stack description             |
| `deadlines`   | Upcoming Android/Play policy dates (bundled) + your own custom entries                 | Nothing required; custom entries live in `project.json`                        |

## Configuration

Three layers:

- **`.env`** — secrets (API keys, OAuth tokens). Never committed. See `.env.example`.
- **`project.json`** — widget toggles, repo paths, feed URLs, everything non-secret. Edited via the settings UI or by hand.
- **Settings UI** (`/settings`) — web form over the above two, with per-widget enable toggles, secret storage (never displays current values), and a Google OAuth connect flow for Firebase/Play widgets.

Editing `project.json` on disk triggers an automatic rebuild — the server watches the file.

## Writing a widget

Each widget exports a `WidgetModule` (see `src/types.ts`):

```ts
export type WidgetModule = {
  id: string;
  title: string;
  envVars?: string[] | ((project: ProjectConfig) => string[]);
  configFields?: FieldSpec[];
  run: (project: ProjectConfig) => Promise<string>;
};
```

1. Create `src/widgets/your-widget.ts` that exports a `WidgetModule`.
2. `run()` returns an HTML string — use the `card`, `errorCard`, `escape`, `relTime`, `truncatedList` helpers in `src/render.ts`.
3. Register it in `src/registry.ts`. Order in that array is the render order on the page.
4. If it needs an env var, list it in `envVars` so the settings page surfaces the `set/missing` status.
5. If it needs config, list the fields in `configFields` — the settings UI generates the form.

The smallest complete example is `src/widgets/feed.ts` (~80 lines, single RSS fetch). `src/widgets/prs.ts` is a clean GitHub API example. `src/widgets/linear.ts` shows a GraphQL POST with client-side filtering.

## Project layout

```
glance/
├── mission-control.ts       # one-shot build entrypoint (npm run start)
├── server.ts                # dev server + settings UI (npm run serve)
├── project.json             # widget config; hand-edited or via /settings
├── .env.example             # documented secrets
├── src/
│   ├── registry.ts          # list of enabled widgets
│   ├── types.ts             # WidgetModule, ProjectConfig, Result
│   ├── render.ts            # shared HTML helpers + top-level page layout
│   ├── settings.ts          # /settings form renderer
│   ├── auth/google.ts       # OAuth flow for Firebase + Play + BigQuery
│   ├── bigquery.ts          # thin BigQuery REST client
│   ├── errors.ts            # Google API error cleanup
│   ├── releaseChecklist.ts  # persistent checkbox state
│   └── widgets/             # one file per widget
└── dist/index.html          # generated output
```

## License

MIT. See `LICENSE`.
