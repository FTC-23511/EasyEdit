# EasyEdit

EasyEdit is the Seattle Solvers browser video editor. Only people on the team's allowlist can sign in, and they sign in with Google.

This README gets the app running on your own computer. You will set up three things: a Google sign-in key, a free database, and a small settings file.

## What works today

- Sign in with Google. Anyone not on the allowlist is turned away.
- An Admin page where admins add people, change their role, and remove them.
- A dashboard where editors create projects in any of five video formats, and rename, duplicate and delete them. A deleted project is hidden and not shown again.
- The editor, which opens a project in the whole window: an add panel on the left, the preview in the middle, the details on the right and the timeline along the bottom. It is always dark, and it asks the Dark Reader browser extension to leave it alone. In it you can:
  - add text clips from three presets (Title, Subtitle, Lower third) and video, image and audio clips from the Media tab, and move, trim, split, delete, ripple-delete, copy and paste clips of every kind
  - add, rename, lock, hide, mute, reorder and remove tracks
  - play the project in the preview, with frame steps, J, K and L, and safe-zone guides for each format
  - undo and redo your own changes, and undo any change listed under Activity, including a teammate's
- Upload video, images and audio in the editor's Media tab (up to 2 GB a file). Uploads go straight from your browser to the team's Google Shared Drive and resume after an interruption.
- Put media on the timeline, trim it, and play it in the preview. Each video gets a small 720p preview copy, so phone footage plays on any laptop.
- Every change is saved as you make it. Other people's changes show up within about two seconds while you are working, and the top bar says who is editing.
- Viewers get the same editor, read-only: they can play and look, but not change anything.
- A project API (see [The project API](#the-project-api)).
- Claude can list, read, create and edit projects for a signed-in member, through a connector added in claude.ai. It can also list the team's media and put it on a timeline.

The editor needs a window at least 1024 px wide. Changes made while offline or signed out wait in the open tab and are sent once you are back. They are not kept if the tab is closed or reloaded first, and the browser asks before that happens. The browser's Back button does not ask, so use **Projects** to leave while changes are waiting.

What's next: thumbnails and waveforms on the timeline, transcripts and footage search for Claude, captions, text animation and effects, a brand kit and templates, exports and the render station, media in exports, voiceover, and posting.

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

    The two media settings at the end of the file, `GOOGLE_SERVICE_ACCOUNT_KEY` and `DRIVE_FOLDER_ID`, can stay empty for now. See [Set up media storage](#set-up-media-storage).

Never share `.env.local` or commit it to git. It holds secrets.

## Set up media storage

Uploaded video, images and audio are kept in a folder of a Google shared drive. This is optional: without it the app runs and edits as usual, and the Media tab says uploads are not set up. You can skip this section now and come back after step 4.

1. **A folder in a shared drive.** In Google Drive, in a team shared drive where you may share folders: New folder, name it `EasyEdit`. Open the folder and copy the id from the address bar (the part after `/folders/`). This is `DRIVE_FOLDER_ID`.
2. **Let an outside account in (only if step 6 is refused).** The service account's address ends in `gserviceaccount.com`, so it is outside the domain, and it will not be a member of the shared drive. A manager of the shared drive opens the drive's name, Shared drive settings, and turns on "Allow people outside Seattle Solvers to access files" and "Allow people who aren't shared drive members to access files". If the switch is missing or greyed out, a Workspace admin must allow it first: admin.google.com, Apps, Google Workspace, Drive and Docs, Sharing settings, "Sharing outside of Seattle Solvers" on for the unit that owns the drive.
3. **The Drive API.** In Google Cloud project `easyedit-514403` (the one that holds the sign-in client): APIs & Services, Library, "Google Drive API", Enable.
4. **A service account.** IAM & Admin, Service Accounts, Create service account, name `easyedit-media`. Give it no project role. Skip the optional steps.
5. **Its key.** Open the service account, Keys, Add key, Create new key, JSON. Move the downloaded file to `~/.config/easyedit/drive-service-account.json` and run `chmod 600` on it. If Google refuses with a policy named `iam.disableServiceAccountKeyCreation`, an organization admin must switch that policy off for this project first.
6. **Share the folder with it.** On the `EasyEdit` folder: Share, add the service account's address (`easyedit-media@easyedit-514403.iam.gserviceaccount.com`), role **Content manager**, untick "Notify people". Do not add it as a member of the drive.
7. **Put the two settings in `.env.local`.** Encode the key on one line:

    ```bash
    base64 -i ~/.config/easyedit/drive-service-account.json | tr -d '\n'
    ```

    Put what it prints after `GOOGLE_SERVICE_ACCOUNT_KEY=`, and the folder id from item 1 after `DRIVE_FOLDER_ID=`. The key is a secret, like the rest of `.env.local`: never paste it into a chat, an issue or a commit.
8. **Restart the app.** Stop `pnpm dev` and start it again, so it reads the new settings.

**Check it.** From the project folder, run the Drive check with the key file and the folder id:

```bash
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=~/.config/easyedit/drive-service-account.json DRIVE_FOLDER_ID=<the folder id> node scripts/drive-check/run.mjs
```

Open `http://localhost:3101` in the browser the team really uses (Edge), press **Run check**, and keep the tab in front until the page says it is done (64 MiB up, so one to a few minutes). The terminal prints F1 to F12 and exits 0. In Google Drive, the shared drive's trash holds the `drive-check` folder. If a line fails, see [If something goes wrong](#if-something-goes-wrong).

Good to know:

- The app keeps files in two folders it makes inside the `EasyEdit` folder: `Originals` for what was uploaded, and `Previews` for the preview copies and still pictures.
- Removing a file in the app moves it to the shared drive's trash, where it stays for 30 days.
- Do not rename or move the files in the drive by hand. Rename and remove them in the app instead.
- Uploads work only from the address in `BETTER_AUTH_URL`. A preview deployment or another address cannot upload.

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

- [ ] On the dashboard, create a project and open it. The editor opens with an empty timeline.
- [ ] Add a clip through the API while the editor is open. Within a few seconds the clip shows up on Text 1, without a reload. To try it, copy the project id from the page address (`/editor/<id>`), copy the value of the `Cookie` request header from your browser's developer tools (Network tab, click any request to the app, then look under **Request Headers**), and run:

    ```bash
    curl -X POST http://localhost:3000/api/projects/<id>/ops \
      -H 'content-type: application/json' \
      -H "cookie: <paste cookie here>" \
      -d '{"baseVersion":0,"ops":[{"op":"add_clip","trackId":"t1","clip":{"type":"text","start":0,"duration":60,"text":"GO SOLVERS","transform":{"x":0.5,"y":0.5,"scale":1,"rotation":0,"opacity":1,"fit":"contain"},"style":{"fontFamily":"Inter","fontSize":96,"fontWeight":800,"color":"#FFFFFF","align":"center"}}}]}'
    ```

    The answer starts with `{"version":1`.

    The cookie is a secret, like `.env.local`: anyone who has it is signed in as you. Do not paste it into chats, issues or commits.

## What to click to check the editor

The editor cannot be opened without a Google sign-in, so the tests cannot click through it. Do this once after a change to the editor, signed in on your own computer. It takes about ten minutes. Use an editor account, and a second account in another browser profile for lines 9, 10 and 12.

1. Open a project from the dashboard. The editor fills the window, dark, with no site header. The top bar shows "Projects", the project's name and "Saved".
2. In the left panel click **Title**. A clip appears on Text 1 at the playhead and the preview shows "Your title". The status flips to "Saving…" and back to "Saved".
3. With the clip selected, type in **Text** in the inspector. The preview follows as you type. Change **Size** and **Color**. Click away: each change is saved once.
4. Drag the clip to the right. It snaps to whole seconds and a guide line shows. Drag its right edge to make it shorter.
5. Put the playhead in the middle of the clip and press `S`: it becomes two clips. Select the second and press `Delete`. Press `Cmd/Ctrl+Z`: it comes back. Press `Shift+Cmd/Ctrl+Z`: it goes again.
6. Click **Subtitle** with the playhead over the first clip. It lands on a new track, "Text 2", in the row just above Text 1: a new track goes just in front of the other tracks of its kind. Open that track's options: **Move down**, then **Move up**. Lock it, then hide it: its text leaves the preview.
7. Select a clip, press `Cmd/Ctrl+C`, move the playhead, press `Cmd/Ctrl+V`. A copy appears at the playhead and is selected.
8. Press `Space` to play and `K` to stop. Click a button such as **Safe zones**, then press `Space`: it plays, and the button is not pressed again. Try `L` twice (2×), `J`, the arrow keys, `Home` and `End`. Turn **Safe zones** off and on. With nothing selected, switch **Format** to Long 16:9: the canvas changes shape.
9. In the second profile open the same project and move a clip. Within about two seconds the first window shows the move and "<name> is editing…". Open **Activity** in the first window: both people's changes are listed. Click **Undo this change** on the other person's move: it moves back in both windows.
10. Change a clip's text in the first window, then change the same text in the second. In the first window press `Cmd/Ctrl+Z`. It says "Can't undo. This was changed afterwards." and the second person's text stays.
11. In the browser's developer tools set the network to Offline and move a clip. The status reads "Offline. Changes will save when you reconnect." Click **Projects**: the browser asks before leaving; stay on the page. Go back online: it reads "Saved". Reload: the move is still there.
12. On the Admin page make the second account a viewer and reload its editor. It shows "View only", every edit control is greyed out, clips cannot be dragged, and Play still works.
13. Sign out in another tab, then move a clip in the editor. It says "You're signed out. Sign in again to save your changes." and the status reads "Signed out". Click **Sign in**: it opens in a new tab. Sign in there and come back to the editor: the status returns to "Saved" and the move is kept.
14. Press `?`. The list of shortcuts opens. Close it with `Escape`.
15. Make the window narrower than 1024 px. The editor is replaced by "The editor needs a wider window."

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

    For uploads, also add `GOOGLE_SERVICE_ACCOUNT_KEY` and `DRIVE_FOLDER_ID`, with the same values as in `.env.local` (see [Set up media storage](#set-up-media-storage)). Add these two for **Production** only, and mark them **Sensitive**.

    Then click **Deploy**. If you don't know the web address until the first deploy finishes, set `BETTER_AUTH_URL` afterwards and redeploy.
3. In Google Cloud, open your OAuth client (step 1, item 10) and add the deployed redirect URI, for example `https://your-app.vercel.app/api/auth/callback/google`. Click **Save**.
4. Once, from the project folder on your computer, create the tables and the first admin in the production database. Put the production connection string in front of each command. It takes precedence over the one in `.env.local`:

    ```bash
    DATABASE_URL='<production connection string>' pnpm db:migrate
    DATABASE_URL='<production connection string>' pnpm db:seed
    ```

    `.env.local` must still exist, because `pnpm db:seed` reads it.

    **Before deploying a version with media:** run the migration against the production database first, with the command above, then deploy. The version that is live now ignores the new table.
5. Optional: publish the Google app, so teammates no longer have to be test users. In Google Cloud, open **Branding** and fill in the app domain details (home page, privacy policy link, authorized domain) with your deployed web address. You will need a public privacy policy page to link to. Then open **Audience** and click **Publish app**. This app only asks Google for name, email and profile picture, and the allowlist still decides who gets in.

## Connect Claude

A member can connect Claude to the app and ask it to read and change projects for them. Claude works as that member, with their role.

**Before deploying a version with the connector:** run the migration against the database first (`pnpm db:migrate`, with the production `DATABASE_URL` as in [Deploy to Vercel](#deploy-to-vercel), step 4), then deploy. With the tables missing, sign-in fails.

**Add the connector:**

1. In claude.ai open **Settings**, then **Connectors**, then **Add custom connector**.
2. Enter exactly `<BETTER_AUTH_URL>/api/mcp`, for example `https://your-app.vercel.app/api/mcp`. Add it, then click **Connect**.
3. Sign in with Google if you are asked to.
4. Check the "Connect Claude" page: it names your account and says what Claude will be able to do. Press **Allow**.

**What Claude can do:**

| Tool | What it does |
| --- | --- |
| `list_projects` | Lists the team's projects, newest change first, and says who you are signed in as. |
| `get_project` | Reads one project's timeline as text: tracks, clips, times and the current version. |
| `create_project` | Creates an empty project with a name and one of the five formats. |
| `edit_timeline` | Applies a list of changes to a project, all or nothing. |
| `add_text` | Adds one or more text clips from a preset (title, subtitle or lower third). |
| `undo_change` | Undoes one earlier change, Claude's or a person's, like **Undo this change** in the editor. |
| `list_assets` | Lists the team's uploaded video, images and audio, newest first, with each one's id, kind, length and size. |
| `add_media` | Puts one or more uploaded files on a project's timeline, laid end to end unless Claude gives start times. |
| `get_editing_guide` | Reads the guide to how projects are built and what is possible today. |

Claude cannot see inside footage yet.

**Roles:** a viewer's Claude can read projects but not change them. An editor's Claude can create and change them. Every change Claude makes is listed in the editor's **Activity** as "Claude (for <name>)" and can be undone there. A change from Claude is refused if the project changed since Claude last read it, and Claude is told what changed, so it never overwrites an edit it has not seen.

**Limits:** through Claude, each member gets 30 changes a minute, 10 MB of change data a day and 50 new projects a day. One page of a read is 16,000 characters; longer projects come in several pages.

**Ending a connection:** the Admin page shows "Connected" next to each member who has allowed Claude. An admin ends a connection by clicking **Disconnect** next to the member, and removing a member ends it too. Removing the connector in claude.ai stops Claude from using it, but the member stays listed as "Connected" until an admin disconnects them. Signing out of the website does not end a connection.

**Only claude.ai can connect.** Claude identifies itself with a client metadata document: its client ID is an https address on claude.ai, and the app reads that document only from claude.ai or claude.com. Apps cannot register themselves. Every connection must also send the member back to one of Claude's callback addresses. The allowed callback addresses and hosts are in `src/lib/connector/config.ts`.

## Who can do what

Every person on the allowlist has one of three roles.

| Role | What they can do today |
| --- | --- |
| Viewer | Sign in, see the dashboard, open projects, see the media library and play media. Cannot create or change anything. |
| Editor | Everything a viewer can, plus create, rename, duplicate and delete projects, and change them. Upload media, and rename and remove it. Deleting hides a project; it is not shown again. |
| Admin | Everything an editor can, plus open the Admin page to add, re-role and remove people. |

Some rules:

- Only emails on the allowlist can sign in. Emails are stored in lowercase.
- A Google account whose email Google has not verified is always rejected.
- There must always be at least one admin. The last admin cannot be demoted or removed.
- Removing someone signs them out right away. They are sent to `/login` on their next request.
- Removing someone also ends their Claude connection right away.
- A file that a project uses cannot be removed from the library. Take it out of that project first.
- You stay signed in for 30 days after your last visit. Each visit starts the 30 days again.

## Project formats

| Format | Size |
| --- | --- |
| Short 9:16 | 1080 x 1920 |
| Feed 4:5 | 1080 x 1350 |
| Square 1:1 | 1080 x 1080 |
| Long 16:9 | 1920 x 1080 |
| Long 4K | 3840 x 2160 |

All projects run at 30 frames per second. Times in the timeline are whole frames.

## Media limits

- File types: video in MP4, M4V, MOV or WebM; images in JPEG, PNG or WebP; audio in MP3, M4A, WAV or AAC. HEIC photos are not taken: save them as JPEG first.
- Up to 2 GB a file. Two uploads run at a time; the rest wait their turn. Each member can have up to 20 unfinished uploads.
- An upload stops if you leave the editor. It goes on from where it stopped when you choose the same file again within 7 days.
- A video's preview copy is made in the uploader's browser. If you leave the editor or press Cancel while the preview is still being made, the video ends up with no preview: at once after Cancel, after up to two hours if you left the editor or closed the tab. Choosing the file again then uploads a second copy, so remove the first one.
- The preview plays the 720p copy. Playing backward is silent, and a volume above 100% sounds like 100% in the preview.
- The browser keeps about 2 GB of playback files, so footage you played before does not download again.

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
| `GET /api/projects/:id/ops?since=N` | viewer and up | Get the changes after version `N`: `{ version, entries, hasMore }`. Each entry is `{ version, ops, inverse, actor, actorName, requestId, createdAt }`. Add `limit` to set the page size (default 100, at most 500). A page holds fewer entries when they are large. When `hasMore` is true, ask again from the `version` in the answer. |
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
- **claude.ai cannot reach or add the connector.** A discovery address is wrong, or `BETTER_AUTH_URL` has a slash at the end. Check that `<BETTER_AUTH_URL>/.well-known/oauth-protected-resource/api/mcp` shows `"resource":"<BETTER_AUTH_URL>/api/mcp"` and `<BETTER_AUTH_URL>/.well-known/oauth-authorization-server/api/auth` shows `"issuer":"<BETTER_AUTH_URL>/api/auth"`, and remove any slash at the end of `BETTER_AUTH_URL`.
- **While connecting Claude, the browser lands on `/api/auth/error?error=invalid_redirect`.** Claude used a callback address that is not on the list. Note the `redirect_uri` from the address bar and add it to `CLAUDE_REDIRECT_URIS` in `src/lib/connector/config.ts`.
- **While connecting Claude, the browser shows `invalid_client`, or "client_id URL is not permitted".** Claude's metadata document is on another host. Note the `client_id` from the address bar and add its host to `CLIENT_DOCUMENT_HOSTS` in `src/lib/connector/config.ts`.
- **After Google you land on the dashboard, not on "Connect Claude".** The login hand-off did not carry the request. Start Connect again in claude.ai while signed in to the website, and report it.
- **Claude is connected, but every tool call fails and claude.ai asks to reconnect in a loop.** Claude did not send the `resource` value, so its token is not bound to `<BETTER_AUTH_URL>/api/mcp`. The endpoint has to be changed to check such tokens another way; report it.
- **"Too many requests" while signing in or connecting.** The rate limit. Wait a minute.
- **The website's own sign-in answers with an error after a deploy.** The migration is not on the live database. Run `pnpm db:migrate` against it (see [Connect Claude](#connect-claude)), or use Vercel's **Promote** on the previous deployment to go back.
- **The Media tab says uploads are not set up.** `GOOGLE_SERVICE_ACCOUNT_KEY` or `DRIVE_FOLDER_ID` is missing where the app runs: in `.env.local` on your computer, or in Vercel's Environment Variables on the deployed app. See [Set up media storage](#set-up-media-storage), then restart or redeploy.
- **Uploads fail at once on the deployed app but work locally.** `BETTER_AUTH_URL` is not the address in the browser. Set it to the exact address people open, with no slash at the end, and redeploy.
- **A video shows "No preview".** Either the uploader's browser could not read it: upload it again from Chrome or Edge on a Mac, or convert it to H.264 first. Or the uploader left the editor or canceled while the preview was being made: remove it and upload it again.

**The Drive check** (`node scripts/drive-check/run.mjs`, in [Set up media storage](#set-up-media-storage)):

| What the script prints | Likely cause | What to do |
| --- | --- | --- |
| F1 fails with `invalid_grant` | The key file is not this service account's, or the computer's clock is wrong | Make a new key ([Set up media storage](#set-up-media-storage), item 5); check the clock |
| F1 passes, F2 fails with `404` | The `EasyEdit` folder is not shared with the service account, or the id is not that folder's | Item 6; copy the id again from the folder's address |
| F2 fails with `403` and a reason about the Drive API | The Drive API is not enabled in the project that owns the service account | Item 3 |
| Sharing the folder in item 6 is refused | Outside members are not allowed | Item 2, with a Workspace admin |
| F4 fails; the console names `Access-Control-Allow-Origin` | Google Drive no longer lets a page send upload pieces to a session the server opened, so uploads from the browser cannot work | Report it; do not retry with other headers |
| F12 fails with `403` | The role is Contributor, not Content manager | Change the role in the folder's Share dialog |
