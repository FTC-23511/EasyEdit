# EasyEdit

EasyEdit is the Seattle Solvers browser video editor. Only people on the team's allowlist can sign in, and they sign in with Google.

This README gets the app running on your own computer. You will set up three things: a Google sign-in key, a free database, and a small settings file.

## What works today

- Sign in with Google. Anyone not on the allowlist is turned away.
- An Admin page where admins add people, change their role, and remove them.
- A dashboard where editors create projects in any of five video formats.
- A project page that shows a text summary of the project.
- A project API (see [The project API](#the-project-api)).

What's next: uploading video, the real timeline editor, exports and posting.

## Before you start

You need:

- [Node.js](https://nodejs.org) version 24
- [pnpm](https://pnpm.io/installation) version 11
- A Google account that can use Google Cloud
- A free [Neon](https://neon.tech) account

Download the code and install it:

```bash
pnpm install
```

## 1. Set up Google sign-in

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and sign in.
2. At the top of the page, click the project picker, then **New Project**. Name it `EasyEdit` and click **Create**. Make sure the new project is selected.
3. Open the menu (three lines, top left) and click **APIs & Services**, then **OAuth consent screen**. If you see **Get started**, click it.
4. Fill in the app name (`EasyEdit`) and your email for support. Click **Next**.
5. For Audience, choose **External**. Click **Next**.
6. Enter your email as the contact, agree to the policy, and click **Create**.
7. While the app is in **Testing** mode, only listed test users can sign in. Open **Audience**, find **Test users**, click **Add users**, and add every Google account that will sign in (including `admin@seattlesolvers.com`). Click **Save**.
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

Open [http://localhost:3000](http://localhost:3000) and click the Google sign-in button.

## First-run checklist

These checks need a real Google client and a real database, so work through them once after setup. Tick each one off.

**Database**

- [ ] `pnpm db:migrate` finishes with no errors against your Neon database.
- [ ] `pnpm db:seed` prints `Seeded admin@seattlesolvers.com`.

**Sign-in**

- [ ] Signing in as `admin@seattlesolvers.com` takes you to `/dashboard`.
- [ ] Signing in with a Google account that is not on the allowlist sends you back to `/login` with the message that the account isn't on the allowlist.

**Admin page** (signed in as the admin)

- [ ] Add a second Google account as `viewer`. That account can sign in, and does not see an **Admin** link.
- [ ] While signed in as that viewer, open `/admin`. You see "You don't have access to this page."
- [ ] Back as admin, change your own role to something else while you are the only admin. You get the last-admin error.
- [ ] Remove the viewer. Their next page load sends them to `/login`.

**Projects** (signed in as admin)

- [ ] On the dashboard, create a project and open it. A text summary of an empty project shows.
- [ ] Add a clip through the API and refresh the project page. The clip shows up. To try it, copy the project id from the page address (`/editor/<id>`), copy your `cookie` request header from your browser's developer tools (Network tab, any request to the app), and run:

    ```bash
    curl -X POST http://localhost:3000/api/projects/<id>/ops \
      -H 'content-type: application/json' \
      -H "cookie: <paste cookie here>" \
      -d '{"baseVersion":0,"ops":[{"op":"add_clip","trackId":"t1","clip":{"type":"text","start":0,"duration":60,"text":"GO SOLVERS","transform":{"x":0.5,"y":0.5,"scale":1,"rotation":0,"opacity":1,"fit":"contain"},"style":{"fontFamily":"Inter","fontSize":96,"fontWeight":800,"color":"#FFFFFF","align":"center"}}}]}'
    ```

    The answer starts with `{"version":1`.

## Who can do what

Every person on the allowlist has one of three roles.

| Role | What they can do today |
| --- | --- |
| Viewer | Sign in, see the dashboard, open projects. Cannot create or change anything. |
| Editor | Everything a viewer can, plus create projects and change them. |
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
| `GET /api/projects/:id/ops?since=N` | viewer and up | Get the changes after version `N`: `{ version, entries: [{ version, ops, actor }] }`. |
| `POST /api/projects/:id/ops` | editor and up | Apply changes: send `{ "baseVersion": N, "ops": [...] }` (1 to 500 ops). Answers `{ version, ops }`. |

Edits are versioned. Send the version you last saw as `baseVersion`. Changes that do not clash with newer edits still apply. A `baseVersion` newer than the project is refused.

Every error has this shape:

```json
{ "code": "CONFLICT", "message": "...", "opIndex": 0, "currentVersion": 3 }
```

`opIndex` (which op failed) and `currentVersion` only appear when they apply.

| Status | `code` | Meaning |
| --- | --- | --- |
| 400 | `INVALID` | The body, query or an op is malformed. |
| 400 | `NOT_FOUND`, `OVERLAP`, `WRONG_TRACK_KIND`, `TRACK_LOCKED`, `TRIM_OUT_OF_RANGE`, `DUPLICATE_ID` | A valid op could not be applied to the project. `opIndex` says which one. |
| 401 | `UNAUTHENTICATED` | Not signed in. |
| 403 | `FORBIDDEN` | Your role does not allow this. |
| 404 | `NOT_FOUND` | No project with that id. |
| 409 | `CONFLICT` | The base version is ahead of the project, or the project kept changing. Reload and retry. |

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
- **Google says the app is blocked or access denied.** Add that account as a test user (step 1, item 7).
- **"DATABASE_URL is not set" or similar.** `.env.local` is missing or has an empty value.
- **You land on `/login` with the allowlist message.** Ask an admin to add your email on the Admin page.
