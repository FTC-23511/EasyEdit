# EasyEdit

EasyEdit is the Seattle Solvers browser video editor. Only people on the team's allowlist can sign in, and they sign in with Google.

This README gets the app running on your own computer. You will set up three things: a Google sign-in key, a free database, and a small settings file.

## What works today

- Sign in with Google. Anyone not on the allowlist is turned away.
- An Admin page where admins add people, change their role, and remove them.
- A dashboard where editors create projects in any of five video formats, and rename, duplicate and delete them. A deleted project is hidden and not shown again.
- A project page that shows a text summary of the project.
- A project API (see [The project API](#the-project-api)).

What's next: uploading video, the real timeline editor, exports and posting.

## Before you start

You need:

- [Node.js](https://nodejs.org) 24 or newer
- [pnpm](https://pnpm.io/installation) version 11
- A Google account that can use Google Cloud
- A free [Neon](https://neon.tech) account

Download the code and install it:

```bash
git clone https://github.com/FTC-23511/EasyEdit.git
cd EasyEdit
pnpm install
```

## 1. Set up Google sign-in

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and sign in.
2. At the top of the page, click the project picker, then **New Project**. Name it `EasyEdit` and click **Create**. Make sure the new project is selected.
3. Open the menu (three lines, top left) and click **APIs & Services**, then **OAuth consent screen**. If you see **Get started**, click it.
4. Fill in the app name (`EasyEdit`) and your email for support. Click **Next**.
5. For Audience, choose **External**. Click **Next**.
6. Enter your email as the contact, agree to the policy, and click **Create**.
7. Add the people who may sign in as test users. Open **Audience**, find **Test users**, click **Add users**, enter each person's Google account, and click **Save** (up to 100 people). Start with `admin@seattlesolvers.com`.

    A new Google app starts in "Testing", where only test users can reach the Google sign-in. So everyone you add on the Admin page also has to be added here.

    Publishing the app lifts that limit, but Google keeps **Publish app** greyed out until the **Branding** page is filled in. That needs a deployed site, so come back to it after [Deploy to Vercel](#deploy-to-vercel).
8. Open **Clients** (or **APIs & Services**, then **Credentials**) and click **Create client** (or **Create credentials**, then **OAuth client ID**).
9. For Application type, choose **Web application**. Name it `EasyEdit web`.
10. Under **Authorized redirect URIs**, click **Add URI** and enter exactly:

    ```
    http://localhost:3000/api/auth/callback/google
    ```

    When you later put the app on a real web address, add a second URI with that address, for example:

    ```
    https://your-app.vercel.app/api/auth/callback/google
    ```

    The path (`/api/auth/callback/google`) must be exact, with no slash at the end.
11. Click **Create**. Copy the **Client ID** and **Client secret**. You will paste them into the settings file in step 3.

## 2. Set up the database

1. Go to [neon.tech](https://neon.tech), sign up (free), and click **Create project**. Pick any name and region.
2. On the project dashboard, click **Connect**.
3. Turn **Connection pooling** on, and copy the connection string. It starts with `postgresql://`. This is your `DATABASE_URL`.

## 3. Fill in the settings file

1. Copy the example file:

    ```bash
    cp .env.example .env.local
    ```

2. Generate a secret for `BETTER_AUTH_SECRET`:

    ```bash
    openssl rand -base64 32
    ```

3. Open `.env.local` and fill it in:

    | Name | What to put |
    | --- | --- |
    | `DATABASE_URL` | The Neon connection string from step 2 |
    | `BETTER_AUTH_SECRET` | The random text from `openssl rand -base64 32` |
    | `BETTER_AUTH_URL` | `http://localhost:3000` on your computer. On a deployed app, its web address. |
    | `GOOGLE_CLIENT_ID` | The Client ID from step 1 |
    | `GOOGLE_CLIENT_SECRET` | The Client secret from step 1 |

Never share `.env.local` or commit it to git. It holds secrets.

## 4. Run it

Create the database tables, add the first admin, and start the app:

```bash
pnpm db:migrate
pnpm db:seed
pnpm dev
```

`pnpm db:seed` adds `admin@seattlesolvers.com` as an admin. It is safe to run again.

When you pull changes that add migrations (new files in the `drizzle` folder), run `pnpm db:migrate` again before `pnpm dev`.

Open [http://localhost:3000](http://localhost:3000) and click the Google sign-in button.

## First-run checklist

These checks need a real Google client and a real database, so work through them once after setup. Tick each one off.

**Database**

- [ ] `pnpm db:migrate` finishes with no errors against your Neon database.
- [ ] `pnpm db:seed` prints `Seeded admin@seattlesolvers.com`.

**Sign-in**

- [ ] Signing in as `admin@seattlesolvers.com` takes you to `/dashboard`.
- [ ] A teammate who is on the allowlist and is a Google test user (step 1, item 7) can sign in.
- [ ] Signing in with a Google account that is not on the allowlist sends you back to `/login` with the message that the account isn't on the allowlist.

**Admin page** (signed in as the admin)

- [ ] Add a second Google account as `viewer`. That account can sign in, and does not see an **Admin** link.
- [ ] While signed in as that viewer, open `/admin`. You see "You don't have access to this page."
- [ ] Back as admin, change your own role to something else while you are the only admin. You get the last-admin error.
- [ ] Remove the viewer. Their next page load sends them to `/login`.

**Projects** (signed in as admin)

- [ ] On the dashboard, create a project and open it. A text summary of an empty project shows.
- [ ] Add a clip through the API and refresh the project page. The clip shows up. To try it, copy the project id from the page address (`/editor/<id>`), copy the value of the `Cookie` request header from your browser's developer tools (Network tab, click any request to the app, then look under **Request Headers**), and run:

    ```bash
    curl -X POST http://localhost:3000/api/projects/<id>/ops \
      -H 'content-type: application/json' \
      -H "cookie: <paste cookie here>" \
      -d '{"baseVersion":0,"ops":[{"op":"add_clip","trackId":"t1","clip":{"type":"text","start":0,"duration":60,"text":"GO SOLVERS","transform":{"x":0.5,"y":0.5,"scale":1,"rotation":0,"opacity":1,"fit":"contain"},"style":{"fontFamily":"Inter","fontSize":96,"fontWeight":800,"color":"#FFFFFF","align":"center"}}}]}'
    ```

    The answer starts with `{"version":1`.

    The cookie is a secret, like `.env.local`: anyone who has it is signed in as you. Do not paste it into chats, issues or commits.

## Deploy to Vercel

The app is meant to run on Vercel for free, on the Hobby tier. Nobody has run these steps yet, so expect to fix small things the first time.

1. Sign in at [vercel.com](https://vercel.com), click **Add New**, then **Project**, and import the `EasyEdit` repository from GitHub. Vercel recognizes it as a Next.js app. Leave the build settings as they are.
2. Before you deploy, open **Environment Variables** and add the same five names as in `.env.local`:

    | Name | What to put |
    | --- | --- |
    | `DATABASE_URL` | The Neon connection string for the database the deployed app should use |
    | `BETTER_AUTH_SECRET` | A new random text from `openssl rand -base64 32` |
    | `BETTER_AUTH_URL` | The deployed web address, for example `https://your-app.vercel.app`, with no slash at the end |
    | `GOOGLE_CLIENT_ID` | The Client ID from step 1 |
    | `GOOGLE_CLIENT_SECRET` | The Client secret from step 1 |

    Then click **Deploy**. If you don't know the web address until the first deploy finishes, set `BETTER_AUTH_URL` afterwards and redeploy.
3. In Google Cloud, open your OAuth client (step 1, item 10) and add the deployed redirect URI, for example `https://your-app.vercel.app/api/auth/callback/google`. Click **Save**.
4. Once, from the project folder on your computer, create the tables and the first admin in the production database. Put the production connection string in front of each command. It takes precedence over the one in `.env.local`:

    ```bash
    DATABASE_URL='<production connection string>' pnpm db:migrate
    DATABASE_URL='<production connection string>' pnpm db:seed
    ```

    `.env.local` must still exist, because `pnpm db:seed` reads it.
5. Optional: publish the Google app, so teammates no longer have to be test users. In Google Cloud, open **Branding** and fill in the app domain details (home page, privacy policy link, authorized domain) with your deployed web address. You will need a public privacy policy page to link to. Then open **Audience** and click **Publish app**. This app only asks Google for name, email and profile picture, and the allowlist still decides who gets in.

## Who can do what

Every person on the allowlist has one of three roles.

| Role | What they can do today |
| --- | --- |
| Viewer | Sign in, see the dashboard, open projects. Cannot create or change anything. |
| Editor | Everything a viewer can, plus create, rename, duplicate and delete projects, and change them. Deleting hides a project; it is not shown again. |
| Admin | Everything an editor can, plus open the Admin page to add, re-role and remove people. |

Some rules:

- Only emails on the allowlist can sign in. Emails are stored in lowercase.
- A Google account whose email Google has not verified is always rejected.
- There must always be at least one admin. The last admin cannot be demoted or removed.
- Removing someone signs them out right away. They are sent to `/login` on their next request.

## Project formats

| Format | Size |
| --- | --- |
| Short 9:16 | 1080 x 1920 |
| Feed 4:5 | 1080 x 1350 |
| Square 1:1 | 1080 x 1080 |
| Long 16:9 | 1920 x 1080 |
| Long 4K | 3840 x 2160 |

All projects run at 30 frames per second. Times in the timeline are whole frames.

## The project API

All routes need you to be signed in (they use the same cookie as the website). Bodies and answers are JSON.

| Route | Who may call it | What it does |
| --- | --- | --- |
| `GET /api/projects` | viewer and up | List projects: `{ "projects": [...] }` |
| `POST /api/projects` | editor and up | Create a project from `{ "name", "format" }`. Answers `201` with `{ "id" }`. |
| `GET /api/projects/:id` | viewer and up | Get `{ id, name, format, doc, version }`. |
| `GET /api/projects/:id/version` | viewer and up | Get just the current version: `{ version }`. |
| `PATCH /api/projects/:id` | editor and up | Rename a project: send `{ "name" }`. Answers `{ id, name }`. |
| `DELETE /api/projects/:id` | editor and up | Delete a project. Answers `204`. |
| `POST /api/projects/:id/duplicate` | editor and up | Make a copy of a project. Answers `201` with `{ "id" }` of the copy. |
| `GET /api/projects/:id/ops?since=N` | viewer and up | Get the changes after version `N`: `{ version, entries, hasMore }`. Each entry is `{ version, ops, inverse, actor, requestId, createdAt }`. Add `limit` to set the page size (default 100, at most 500). A page holds fewer entries when they are large. When `hasMore` is true, ask again from the `version` in the answer. |
| `POST /api/projects/:id/ops` | editor and up | Apply changes: send `{ "baseVersion": N, "ops": [...] }` (1 to 500 ops). Answers `{ version, ops, inverse }`. |

Edits are versioned. Send the version you last saw as `baseVersion`. Changes that do not clash with newer edits still apply. A `baseVersion` newer than the project is refused.

`inverse` is the ops that undo this change, to send back later as an ordinary edit. To make a write that is refused unless `baseVersion` is exactly the current version, add `"strict": true`. A strict write is never applied on top of newer edits.

To make a write safe to retry, add a `"requestId"` of 8 to 64 letters, digits, `-` or `_`. If a write with that `requestId` already landed in this project, the answer is the original one and nothing is applied again. Use a new `requestId` for every change and repeat it only to resend that same change: a different change sent under a used `requestId` is not applied. Each op-log entry shows its `requestId`, or `null` when none was sent.

When a route refuses a request, the answer has this shape:

```json
{ "code": "CONFLICT", "message": "...", "opIndex": 0, "currentVersion": 3 }
```

`opIndex` (which op failed) and `currentVersion` only appear when they apply. An unexpected failure answers `500` with `{ "code": "INTERNAL", "message" }`.

| Status | `code` | Meaning |
| --- | --- | --- |
| 400 | `INVALID` | The body, query, project name or an op is malformed, `ops` is empty, or the `requestId` is malformed or was already used by someone else. |
| 400 | `LIMIT_EXCEEDED` | Too many ops (more than 500), tracks or clips, a change too large to store or too large to undo in one step, or the project is too large. |
| 400 | `STALE` | An undo no longer applies, because that part of the project was changed since. |
| 400 | `NOT_FOUND`, `OVERLAP`, `WRONG_TRACK_KIND`, `TRACK_LOCKED`, `TRIM_OUT_OF_RANGE`, `DUPLICATE_ID` | A valid op could not be applied to the project. `opIndex` says which one. |
| 401 | `UNAUTHENTICATED` | Not signed in. |
| 403 | `FORBIDDEN` | Your role does not allow this, or the request came from another site. |
| 404 | `NOT_FOUND` | No project with that id. |
| 409 | `CONFLICT` | The base version is ahead of the project, a strict write was not at the current version, or the project kept changing. Reload and retry. |

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Start the app at http://localhost:3000 |
| `pnpm build` | Build the app for production |
| `pnpm start` | Run the built app |
| `pnpm test` | Run the tests |
| `pnpm typecheck` | Check the TypeScript types |
| `pnpm lint` | Check code style |
| `pnpm db:generate` | Create a new migration after changing `src/db/schema.ts` |
| `pnpm db:migrate` | Apply migrations to the database in `DATABASE_URL` |
| `pnpm db:seed` | Add `admin@seattlesolvers.com` as an admin |

## If something goes wrong

- **Google says `redirect_uri_mismatch`.** The redirect URI in Google Cloud does not exactly match `<BETTER_AUTH_URL>/api/auth/callback/google`. Fix it in step 1.
- **Google blocks an account that is on the allowlist.** While the Google app is in Testing, that account also has to be a test user. Add it under **Audience**, then **Test users** in Google Cloud (step 1, item 7).
- **"DATABASE_URL is not set" or similar.** `.env.local` is missing or has an empty value.
- **You land on `/login` with the allowlist message.** Ask an admin to add your email on the Admin page.
- **You land on `/login` with "Sign-in didn't finish".** Sign-in was cancelled or failed partway. Try again. If it keeps happening, ask an admin to check that you're on the allowlist.
