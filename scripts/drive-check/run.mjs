// The Drive check: does the media upload path work against the real Google
// Drive, from a real browser page?
//
//   GOOGLE_SERVICE_ACCOUNT_KEY_FILE=… DRIVE_FOLDER_ID=… node scripts/drive-check/run.mjs
//     serves http://localhost:3101, waits for the page to post its result,
//     prints one line per fact (F1 to F12), writes out/result.json, moves every
//     test file to the trash, and exits 0 only if every required fact passed.
//
//   node scripts/drive-check/run.mjs --self-test
//     runs the same server code, and the page's own script, against a pretend
//     Google inside this file. It never reaches the network.
//
// Plain Node 24, no package. Nothing it prints or writes holds a token, the
// key, or an upload session address: every line goes through scrub(), and
// result.json holds only booleans, status codes and numbers.

import http from "node:http";
import vm from "node:vm";
import { generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  API,
  FOLDER_MIME,
  GoogleError,
  READ_SCOPE,
  TOKEN_URL,
  WRITE_SCOPE,
  askOffset,
  createFolder,
  generateFileId,
  getFile,
  md5Hex,
  openSession,
  patternBytes,
  readKeyFile,
  tokenFor,
  trashFile,
} from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 3101;
const BIG = 67108864; // 64 MiB
const PIECE = 8388608; // 8 MiB
const SMALL = 1048576; // 1 MiB
const OFFSET_LOW = 2 * PIECE; // 16,777,216: the third piece's first byte
const OFFSET_HIGH = 3 * PIECE; // 25,165,824: just past its last byte
const MIME = "application/octet-stream";
const TOKEN_REFRESH_MS = 50 * 60 * 1000;

// ---------------------------------------------------------------------------
// The facts and how each is judged. Pure functions, so the self-test can also
// show each verdict fails when it should.

const REQUIRED = {
  F1: true, F2: true, F3: true, F4: true, F5: false, F6: true,
  F7: true, F8: true, F9: true, F10: false, F11: false, F12: true,
};
const ORDER = Object.keys(REQUIRED);

const yesNo = (value) => (value ? "yes" : "no");
const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const bool = (value) => value === true;

function fact(id, pass, text, data = {}) {
  const required = REQUIRED[id];
  return {
    id,
    required,
    verdict: required ? (pass ? "PASS" : "FAIL") : "RECORDED",
    text,
    data: required ? { pass, ...data } : data,
  };
}

const notRun = (id) => fact(id, false, "not run");

const judge = {
  F1(token, error) {
    if (!token) return fact("F1", false, error ?? "no answer");
    return fact("F1", true, `issued for the drive scope; expires_in ${token.expiresIn}`, { expiresIn: num(token.expiresIn) });
  },
  F2(folderFile, rootId, error) {
    if (!folderFile) return fact("F2", false, error ?? "no folder");
    const parentOk = folderFile.parents?.[0] === rootId;
    const driveId = typeof folderFile.driveId === "string" ? folderFile.driveId : null;
    return fact(
      "F2",
      parentOk,
      `drive-check folder made; its parents[0] is the media folder: ${yesNo(parentOk)}; driveId ${driveId ?? "none"}` +
        (driveId ? ` (${driveId === rootId ? "the same as" : "not"} the media folder's id)` : ""),
      { driveIdPresent: driveId !== null, driveIdIsMediaFolder: driveId === rootId },
    );
  },
  F3(bigId, bigFile, error) {
    if (!bigId) return fact("F3", false, `no session was opened for the 64 MiB file${error ? `: ${error}` : ""}`);
    const pass = bigFile?.id === bigId;
    return fact(
      "F3",
      pass,
      pass
        ? "a session opened with an id from generateIds was accepted, and files.get finds the file under that id"
        : `files.get on the preset id: ${error ?? "a different id came back"}`,
    );
  },
  F4(page) {
    const { readable, status } = page.firstPiece;
    const pass = readable && status === 308;
    return fact(
      "F4",
      pass,
      readable
        ? `the first piece was answered ${status}, readable by the page`
        : "the page could not read the answer to the first piece (look for a cross-origin error in the browser console)",
      { readable, status },
    );
  },
  F5(page) {
    const { rangeReadable, rangeEnd } = page.firstPiece;
    return fact(
      "F5",
      rangeReadable,
      `the page ${rangeReadable ? "could" : "could not"} read the Range header of that 308${rangeEnd !== null ? ` (bytes=0-${rangeEnd})` : ""}`,
      { readable: rangeReadable, rangeEnd },
    );
  },
  F6offset(offset) {
    const inRange = offset !== null && offset >= OFFSET_LOW && offset <= OFFSET_HIGH;
    return fact("F6", inRange, `offset ${offset ?? "none"} after the aborted third piece (${OFFSET_LOW} to ${OFFSET_HIGH}: ${yesNo(inRange)})`);
  },
  F6(offset, page) {
    const inRange = offset !== null && offset >= OFFSET_LOW && offset <= OFFSET_HIGH;
    const continued = offset !== null && page.resumedFrom === offset;
    const lastOk = page.lastStatus === 200 || page.lastStatus === 201;
    return fact(
      "F6",
      inRange && continued && lastOk,
      `offset ${offset ?? "none"} after the aborted third piece (${OFFSET_LOW} to ${OFFSET_HIGH}: ${yesNo(inRange)}); ` +
        `went on from it: ${yesNo(continued)}; last PUT ${page.lastStatus ?? "not readable"}; ` +
        `id readable from that answer: ${yesNo(page.idReadable)}` +
        (page.thirdPieceAborted ? "" : "; the third piece finished before the abort"),
      {
        offset,
        inRange,
        continuedFromIt: continued,
        lastStatus: page.lastStatus,
        idReadable: page.idReadable,
        idMatches: page.idMatches,
        thirdPieceAborted: page.thirdPieceAborted,
      },
    );
  },
  F7(file, folder, expectedMd5, error) {
    if (!file) return fact("F7", false, `files.get on the 64 MiB file: ${error ?? "no answer"}`);
    const sizeOk = file.size === String(BIG);
    const md5Ok = typeof file.md5Checksum === "string" && file.md5Checksum === expectedMd5;
    const parentOk = Array.isArray(file.parents) && file.parents.length === 1 && file.parents[0] === folder.id;
    const driveOk = typeof file.driveId === "string" && file.driveId === folder.driveId;
    return fact(
      "F7",
      sizeOk && md5Ok && parentOk && driveOk,
      `size ${file.size ?? "none"} (${BIG}: ${yesNo(sizeOk)}); md5 matches: ${yesNo(md5Ok)}; ` +
        `parent is the drive-check folder: ${yesNo(parentOk)}; same driveId as F2: ${yesNo(driveOk)}`,
      { sizeOk, md5Ok, parentOk, driveIdOk: driveOk },
    );
  },
  F8(page) {
    const { small, bigRange } = page;
    return fact(
      "F8",
      small.wholeMatch,
      `whole read of the 1 MiB file: ${small.wholeStatus ?? "not readable"}, bytes match: ${yesNo(small.wholeMatch)}; ` +
        `Range 0-1023 on it: ${small.rangeStatus ?? "not readable"}, 206 with 1,024 matching bytes: ${yesNo(small.rangeMatch)}; ` +
        `in the middle of the 64 MiB file: ${bigRange.status ?? "not readable"}, 206 with 1,024 matching bytes: ${yesNo(bigRange.match)}`,
      {
        wholeStatus: small.wholeStatus,
        smallRangeStatus: small.rangeStatus,
        smallRange206: small.rangeMatch,
        bigRangeStatus: bigRange.status,
        bigRange206: bigRange.match,
      },
    );
  },
  F9(trash, error) {
    if (!trash) return fact("F9", false, error ?? "not tried");
    return fact(
      "F9",
      trash.status === 403,
      `moving a file to the trash with the read-only scope answered ${trash.status}${trash.reason ? ` ${trash.reason}` : ""}`,
      { status: trash.status },
    );
  },
  F10(page) {
    const { readable, status } = page.noOrigin;
    return fact(
      "F10",
      readable,
      `session opened with no Origin: the page ${readable ? `could read the answer to its PUT (${status})` : "could not read the answer to its PUT"}`,
      { readable, status },
    );
  },
  F11(page) {
    const { mbPerSecond, uploadSeconds } = page;
    return fact(
      "F11",
      mbPerSecond !== null,
      mbPerSecond !== null
        ? `${mbPerSecond.toFixed(1)} MB/s (${(uploadSeconds ?? 0).toFixed(1)} s of PUTs for 64 MiB)`
        : "not measured",
      { mbPerSecond, uploadSeconds },
    );
  },
  // `items`: { key, name, trashed: true | false | null }. null is a file that
  // was never made (its upload did not finish), which leaves nothing to trash;
  // the folder always exists by then.
  F12(items, refusedStatus, error) {
    if (error) return fact("F12", false, error);
    const pass = items.every((item) => item.trashed === true || (item.trashed === null && item.key !== "folder"));
    const text = items
      .map((item) => `${item.name} ${item.trashed === null ? "never made" : yesNo(item.trashed)}`)
      .join(", ");
    const data = {};
    for (const item of items) data[`${item.key}Trashed`] = item.trashed;
    return fact("F12", pass, `in the trash: ${text}${refusedStatus ? ` (a trash call answered ${refusedStatus})` : ""}`, data);
  },
};

// The page's report, reduced to the fields and types the verdicts read.
function cleanPage(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  return {
    firstPiece: {
      readable: bool(p.firstPiece?.readable),
      status: num(p.firstPiece?.status),
      rangeReadable: bool(p.firstPiece?.rangeReadable),
      rangeEnd: num(p.firstPiece?.rangeEnd),
    },
    thirdPieceAborted: bool(p.thirdPieceAborted),
    resumedFrom: num(p.resumedFrom),
    lastStatus: num(p.lastStatus),
    idReadable: bool(p.idReadable),
    idMatches: bool(p.idMatches),
    uploadSeconds: num(p.uploadSeconds),
    mbPerSecond: num(p.mbPerSecond),
    small: {
      uploaded: bool(p.small?.uploaded),
      wholeStatus: num(p.small?.wholeStatus),
      wholeMatch: bool(p.small?.wholeMatch),
      rangeStatus: num(p.small?.rangeStatus),
      rangeMatch: bool(p.small?.rangeMatch),
    },
    bigRange: { status: num(p.bigRange?.status), match: bool(p.bigRange?.match) },
    noOrigin: { readable: bool(p.noOrigin?.readable), status: num(p.noOrigin?.status) },
    error: typeof p.error === "string" ? p.error.slice(0, 200) : null,
  };
}

// Keeps only booleans, finite numbers and null (inside objects).
function numbersAndBooleans(value) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const kept = numbersAndBooleans(v);
      if (kept !== undefined) out[k] = kept;
    }
    return out;
  }
  return undefined;
}

function onlyNumbersAndBooleans(value) {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (value && typeof value === "object" && !Array.isArray(value)) return Object.values(value).every(onlyNumbersAndBooleans);
  return false;
}

// ---------------------------------------------------------------------------
// The check: its state, the local server's routes, and the verdict.

function createCheck({ key, rootId, google, origin, print }) {
  const port = new URL(origin).port;
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);

  // Everything that must never be printed. Tokens and session addresses are
  // added the moment they arrive.
  const secrets = new Set();
  const keep = (secret) => {
    if (typeof secret === "string" && secret.length > 0) secrets.add(secret);
    return secret;
  };
  keep(key.private_key);
  for (const line of key.private_key.split(/\r?\n/)) if (line.length >= 16 && !line.startsWith("-----")) keep(line);

  function scrub(text) {
    let out = String(text);
    for (const secret of secrets) if (out.includes(secret)) out = out.split(secret).join("[hidden]");
    return out;
  }
  const say = (line) => print(scrub(line));
  const describe = (error) => scrub(error instanceof Error ? error.message : String(error));

  const facts = new Map();
  const sessions = new Map(); // file id -> { role, size, sessionUrl, offsets }
  const byRole = {};
  const openErrors = {};
  const known = new Set(); // ids the page may ask about
  let ready = false;
  let write = null;
  let read = null;
  let folder = null; // { id, driveId }
  let trashWithRead = null;
  let finished = false;
  let cleanup = null;
  let offsetFact = null;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  async function writeAccess() {
    if (!write || Date.now() - write.at > TOKEN_REFRESH_MS) {
      const issued = await tokenFor(key, WRITE_SCOPE, google);
      keep(issued.accessToken);
      write = { ...issued, at: Date.now() };
    }
    return write.accessToken;
  }

  async function readAccess() {
    if (!read || Date.now() - read.at > TOKEN_REFRESH_MS) {
      const issued = await tokenFor(key, READ_SCOPE, google);
      keep(issued.accessToken);
      read = { ...issued, at: Date.now() };
    }
    return read;
  }

  // F1 and F2, before the page is used.
  async function setup() {
    try {
      await writeAccess();
      facts.set("F1", judge.F1(write));
    } catch (error) {
      facts.set("F1", judge.F1(null, describe(error)));
      return false;
    }
    try {
      const token = await writeAccess();
      const id = await createFolder(token, { name: "drive-check", parentId: rootId }, google);
      folder = { id, driveId: null };
      known.add(id);
      const made = await getFile(token, id, google);
      folder.driveId = typeof made.driveId === "string" ? made.driveId : null;
      const f2 = judge.F2(made, rootId);
      facts.set("F2", f2);
      ready = f2.verdict === "PASS";
    } catch (error) {
      facts.set("F2", judge.F2(null, rootId, describe(error)));
    }
    return ready;
  }

  async function routeSession(body) {
    const size = body?.size;
    const mode = body?.origin;
    if (!Number.isSafeInteger(size) || size < 1 || size > BIG || (mode !== "page" && mode !== "none")) {
      return [400, { error: "size and origin (page or none) are required" }];
    }
    if (!ready) return [409, { error: "the check is not set up" }];
    const role = mode === "none" ? "noOrigin" : size === BIG ? "big" : size === SMALL ? "small" : "other";
    if (byRole[role]) return [409, { error: "that session is already open; start the script again to run the check again" }];
    try {
      const token = await writeAccess();
      const fileId = await generateFileId(token, google);
      const sessionUrl = keep(
        await openSession(
          token,
          { id: fileId, name: `drive-check-${role}.bin`, parentId: folder.id, mimeType: MIME, size, origin: mode === "page" ? origin : null },
          google,
        ),
      );
      sessions.set(fileId, { role, size, sessionUrl, offsets: [] });
      byRole[role] = fileId;
      known.add(fileId);
      return [200, { sessionUrl, fileId }];
    } catch (error) {
      openErrors[role] = describe(error);
      return [502, { error: openErrors[role] }];
    }
  }

  async function routeOffset(body) {
    const session = [...sessions.values()].find((s) => s.sessionUrl === body?.sessionUrl);
    if (!session) return [404, { error: "not a session this check opened" }];
    if (body.size !== session.size) return [400, { error: "the size does not match the session" }];
    const answer = await askOffset(session.sessionUrl, session.size, google);
    session.offsets.push(answer.offset);
    return [200, { done: answer.done, offset: answer.offset }];
  }

  async function routeFile(id) {
    if (!known.has(id)) return [404, { error: "not a file this check made" }];
    const file = await getFile(await writeAccess(), id, google);
    return [200, {
      size: file.size ?? null,
      md5: file.md5Checksum ?? null,
      parents: file.parents ?? [],
      driveId: file.driveId ?? null,
      trashed: file.trashed === true,
    }];
  }

  async function routeReadAccess() {
    const issued = await readAccess();
    return [200, { accessToken: issued.accessToken, expiresIn: issued.expiresIn }];
  }

  async function routeTrashWithRead(id) {
    if (!known.has(id)) return [404, { error: "not a file this check made" }];
    const issued = await readAccess();
    trashWithRead = await trashFile(issued.accessToken, id, google);
    return [200, { status: trashWithRead.status }];
  }

  async function handle(req, res) {
    try {
      const host = req.headers.host ?? "";
      if (!hosts.has(host)) return reply(res, 421, { error: "wrong host" });
      const url = new URL(req.url ?? "/", origin);
      if (req.method === "GET" && url.pathname === "/") {
        if (host !== `localhost:${port}`) {
          res.writeHead(302, { Location: `${origin}/` });
          return res.end();
        }
        const html = await readFile(join(HERE, "page.html"));
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(html);
      }
      if (req.method === "GET" && url.pathname.startsWith("/file/")) {
        return reply(res, ...(await routeFile(decodeURIComponent(url.pathname.slice("/file/".length)))));
      }
      if (req.method !== "POST") return reply(res, 404, { error: "not found" });
      if (req.headers.origin && req.headers.origin !== origin) return reply(res, 403, { error: "wrong origin" });
      const body = await readJson(req);
      if (url.pathname === "/session") return reply(res, ...(await routeSession(body)));
      if (url.pathname === "/offset") return reply(res, ...(await routeOffset(body)));
      if (url.pathname === "/read-token") return reply(res, ...(await routeReadAccess()));
      if (url.pathname.startsWith("/trash-with-read-token/")) {
        return reply(res, ...(await routeTrashWithRead(decodeURIComponent(url.pathname.slice("/trash-with-read-token/".length)))));
      }
      if (url.pathname === "/result") {
        if (finished) return reply(res, 409, { error: "the result is already in; start the script again to run the check again" });
        finished = true;
        const outcome = await finish(body);
        res.once("finish", () => resolveDone(outcome));
        return reply(res, 200, { ok: outcome.ok, lines: outcome.lines });
      }
      return reply(res, 404, { error: "not found" });
    } catch (error) {
      if (!res.headersSent) reply(res, 502, { error: describe(error) });
    }
  }

  // F12: every file this check made, then the folder, to the trash.
  function trashEverything() {
    cleanup ??= (async () => {
      if (!folder) return judge.F12([], null, "nothing to move to the trash: the folder was never made");
      let token;
      try {
        token = await writeAccess();
      } catch (error) {
        return judge.F12([], null, describe(error));
      }
      let refused = null;
      const ids = [...sessions.keys(), folder.id];
      for (const id of ids) {
        const answer = await trashFile(token, id, google);
        if (answer.status !== 200 && answer.status !== 404) refused ??= answer.status;
      }
      async function trashed(id) {
        if (!id) return null;
        try {
          return (await getFile(token, id, google)).trashed === true;
        } catch (error) {
          return error instanceof GoogleError && error.status === 404 ? null : false;
        }
      }
      const items = [
        { key: "folder", name: "folder", trashed: await trashed(folder.id) },
        { key: "big", name: "64 MiB file", trashed: await trashed(byRole.big) },
        { key: "small", name: "1 MiB file", trashed: await trashed(byRole.small) },
        { key: "noOrigin", name: "no-Origin file", trashed: await trashed(byRole.noOrigin) },
      ];
      if (byRole.other) items.push({ key: "other", name: "other file", trashed: await trashed(byRole.other) });
      return judge.F12(items, refused);
    })();
    return cleanup;
  }

  async function finish(rawPage) {
    const page = cleanPage(rawPage);
    if (page.error) say(`The page stopped early: ${page.error}`);
    if (ready) {
      const bigId = byRole.big ?? null;
      let bigFile = null;
      let bigError = openErrors.big ?? null;
      if (bigId) {
        try {
          bigFile = await getFile(await writeAccess(), bigId, google);
        } catch (error) {
          bigError = describe(error);
        }
      }
      const offset = bigId ? (sessions.get(bigId).offsets[0] ?? null) : null;
      offsetFact = judge.F6offset(offset);
      facts.set("F3", judge.F3(bigId, bigFile, bigError));
      facts.set("F4", judge.F4(page));
      facts.set("F5", judge.F5(page));
      facts.set("F6", judge.F6(offset, page));
      facts.set("F7", judge.F7(bigFile, folder, bigFile ? md5Hex(patternBytes(BIG)) : null, bigError));
      facts.set("F8", judge.F8(page));
      let trashError = null;
      const target = byRole.small ?? bigId;
      if (!trashWithRead && target) {
        try {
          trashWithRead = await trashFile((await readAccess()).accessToken, target, google);
        } catch (error) {
          trashError = describe(error);
        }
      }
      facts.set("F9", judge.F9(trashWithRead, trashError));
      facts.set("F10", judge.F10(page));
      facts.set("F11", judge.F11(page));
    }
    facts.set("F12", await trashEverything());
    const list = ORDER.map((id) => facts.get(id) ?? notRun(id));
    const lines = list.map((f) => scrub(`${f.id} ${f.verdict} ${f.text}`));
    for (const line of lines) say(line);
    const ok = list.every((f) => !f.required || f.verdict === "PASS");
    const json = numbersAndBooleans({
      ok,
      facts: Object.fromEntries(list.map((f) => [f.id, { required: f.required, ...f.data }])),
    });
    return { ok, lines, json };
  }

  // The lines for the facts the server can judge alone (the self-test's output).
  function serverLines() {
    return ["F1", "F2", "F3", "F6offset", "F7", "F9", "F12"]
      .map((id) => (id === "F6offset" ? offsetFact : facts.get(id)) ?? notRun(id === "F6offset" ? "F6" : id))
      .map((f) => ({ verdict: f.verdict, line: scrub(`${f.id} ${f.verdict} ${f.text}`) }));
  }

  return { setup, handle, finish, trashEverything, done, serverLines, say };
}

function reply(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 65536) throw new Error("the request body is too large");
    chunks.push(chunk);
  }
  if (length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("the request body is not JSON");
  }
}

// Listens on 127.0.0.1 and, when it can, on ::1 too, so http://localhost works
// whichever address the browser tries first. Never on other interfaces.
function listen(handler, port) {
  return new Promise((resolve, reject) => {
    const first = http.createServer(handler);
    first.once("error", reject);
    first.listen(port, "127.0.0.1", () => {
      const actual = first.address().port;
      const second = http.createServer(handler);
      second.once("error", () => resolve({ port: actual, servers: [first] }));
      second.listen(actual, "::1", () => resolve({ port: actual, servers: [first, second] }));
    });
  });
}

function closeAll(servers) {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
}

async function writeResult(path, json) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(json, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// The real run.

async function main() {
  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
  const rootId = process.env.DRIVE_FOLDER_ID;
  if (!keyFile || !rootId) {
    console.error("Set GOOGLE_SERVICE_ACCOUNT_KEY_FILE and DRIVE_FOLDER_ID, or pass --self-test.");
    return 2;
  }
  const key = await readKeyFile(keyFile);
  const origin = `http://localhost:${PORT}`;
  const check = createCheck({ key, rootId, google: globalThis.fetch, origin, print: (line) => console.log(line) });
  let servers;
  try {
    ({ servers } = await listen((req, res) => check.handle(req, res), PORT));
  } catch (error) {
    console.error(`Cannot listen on port ${PORT} (${error?.code ?? "error"}).`);
    return 1;
  }
  let outcome;
  if (await check.setup()) {
    process.once("SIGINT", () => {
      check.say("Stopped. Moving the test files to the trash.");
      check.trashEverything().then((f12) => {
        check.say(`${f12.id} ${f12.verdict} ${f12.text}`);
        process.exit(130);
      });
    });
    check.say(`Open ${origin} in the browser, press Run check, and keep the tab in front until it says it is done.`);
    outcome = await check.done;
  } else {
    outcome = await check.finish(null);
  }
  closeAll(servers);
  await writeResult(join(HERE, "out", "result.json"), outcome.json);
  check.say(outcome.ok ? "Every required fact passed." : "Some required facts failed.");
  check.say("Wrote scripts/drive-check/out/result.json.");
  return outcome.ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// The pretend Google, for --self-test. It behaves the way the real one was
// seen to behave in drive-facts.md: it checks the JWT's signature and claims;
// a read-only scope cannot write (403); a shared-drive file is found only with
// supportsAllDrives=true; a list without both AllDrives flags finds nothing and
// a list by drive is refused; a file's driveId is the shared drive's id, never
// the folder's; a session answers 308 with Range until complete, keeps only
// whole 256 KiB blocks of an unfinished piece, answers its PUTs with
// Access-Control-Allow-Origin naming the Origin it was opened with (or "null"
// when opened without one), and 499 once cancelled; a file cannot be deleted
// for good (404), only trashed; trashing a folder trashes what is in it.

const PRETEND_DRIVE_ID = "0APretendSharedDriveId";
const BLOCK = 262144; // 256 KiB
const SESSION_EXPOSE = "Content-Length, Content-Type, Date, Range, Server, X-GUploader-UploadID";

function bodyOf(body) {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new TypeError("pretend Google: unsupported body");
}

function pretendGoogle({ clientEmail, publicKey, rootId }) {
  const tokens = new Map(); // access token -> scope
  const assertions = [];
  const sessionUrls = [];
  const generated = new Set();
  const files = new Map();
  const sessions = new Map();
  const newId = () => `1${randomBytes(24).toString("base64url")}`;
  files.set(rootId, { id: rootId, name: "EasyEdit", mimeType: FOLDER_MIME, parents: [PRETEND_DRIVE_ID], driveId: PRETEND_DRIVE_ID, trashed: false });

  const json = (status, body, headers = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=UTF-8", ...headers } });
  const driveError = (status, reason, message, headers = {}) =>
    json(status, { error: { code: status, message, errors: [{ domain: "global", reason, message }] } }, headers);
  const oauthError = (error, description) => json(400, { error, error_description: description });

  function isTrashed(file) {
    for (let f = file; f; f = files.get(f.parents?.[0])) if (f.trashed) return true;
    return false;
  }

  function pick(file, fields) {
    const all = {
      kind: "drive#file",
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      size: file.size,
      md5Checksum: file.md5Checksum,
      parents: file.parents,
      driveId: file.driveId,
      trashed: isTrashed(file),
    };
    const wanted = fields ? fields.split(",").map((f) => f.trim()) : ["kind", "id", "name", "mimeType"];
    const out = {};
    for (const field of wanted) if (all[field] !== undefined) out[field] = all[field];
    return out;
  }

  function scopeOf(headers) {
    const match = /^Bearer (.+)$/.exec(headers.get("authorization") ?? "");
    return match ? (tokens.get(match[1]) ?? null) : null;
  }

  function findFile(id, url) {
    const file = files.get(id);
    if (!file) return null;
    if (file.driveId && url.searchParams.get("supportsAllDrives") !== "true") return null;
    return file;
  }

  function token(headers, body) {
    if (!(headers.get("content-type") ?? "").startsWith("application/x-www-form-urlencoded")) {
      return oauthError("invalid_request", "Bad content type.");
    }
    const form = new URLSearchParams(body.toString("utf8"));
    if (form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer") {
      return oauthError("unsupported_grant_type", "Invalid grant_type.");
    }
    const assertion = form.get("assertion") ?? "";
    assertions.push(assertion);
    const [h, c, s] = assertion.split(".");
    let header;
    let claims;
    try {
      header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
      claims = JSON.parse(Buffer.from(c, "base64url").toString("utf8"));
    } catch {
      return oauthError("invalid_grant", "Invalid JWT.");
    }
    if (header.alg !== "RS256" || header.typ !== "JWT" || Object.keys(header).length !== 2) {
      return oauthError("invalid_grant", "Invalid JWT header.");
    }
    let signed = false;
    try {
      signed = Boolean(s) && verify("sha256", Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, "base64url"));
    } catch {
      signed = false;
    }
    if (!signed) return oauthError("invalid_grant", "Invalid JWT Signature.");
    const now = Date.now() / 1000;
    if (claims.iss !== clientEmail || claims.aud !== TOKEN_URL || claims.exp - claims.iat !== 3600 || Math.abs(claims.iat - now) > 300) {
      return oauthError("invalid_grant", "Invalid JWT claims.");
    }
    if (claims.scope !== WRITE_SCOPE && claims.scope !== READ_SCOPE) return oauthError("invalid_scope", "Invalid scope.");
    const accessToken = `ya29.pretend-${randomBytes(24).toString("hex")}`;
    tokens.set(accessToken, claims.scope);
    return json(200, { access_token: accessToken, expires_in: 3599, token_type: "Bearer" });
  }

  // Any origin's preflight is allowed, as on Drive (drive-facts 8, 10, 12).
  function preflight(headers) {
    return new Response(null, {
      status: 200,
      headers: {
        "access-control-allow-origin": headers.get("origin") ?? "*",
        "access-control-allow-methods": headers.get("access-control-request-method") ?? "GET",
        "access-control-allow-headers": headers.get("access-control-request-headers") ?? "",
        "access-control-max-age": "3600",
      },
    });
  }

  function openUpload(url, headers, body) {
    const scope = scopeOf(headers);
    if (!scope) return driveError(401, "authError", "Invalid Credentials");
    if (scope !== WRITE_SCOPE) return driveError(403, "insufficientPermissions", "Insufficient Permission");
    const size = Number(headers.get("x-upload-content-length"));
    if (!Number.isSafeInteger(size) || size < 0) return driveError(400, "badRequest", "Bad X-Upload-Content-Length.");
    let meta;
    try {
      meta = JSON.parse(body.toString("utf8"));
    } catch {
      return driveError(400, "parseError", "Parse Error");
    }
    const parent = findFile(meta.parents?.[0], url);
    if (!parent || parent.mimeType !== FOLDER_MIME || isTrashed(parent)) return driveError(404, "notFound", "File not found.");
    if (meta.id !== undefined && !generated.has(meta.id)) return driveError(400, "invalid", "The provided file ID is not usable.");
    const uploadId = randomBytes(32).toString("base64url");
    const sessionUrl = `${API}/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&upload_id=${uploadId}`;
    sessionUrls.push(sessionUrl);
    const origin = headers.get("origin");
    sessions.set(uploadId, {
      origin,
      size,
      meta,
      mimeType: headers.get("x-upload-content-type") ?? meta.mimeType,
      driveId: parent.driveId,
      chunks: [],
      received: 0,
      file: null,
      cancelled: false,
    });
    const answerHeaders = { location: sessionUrl };
    if (origin) {
      answerHeaders["access-control-allow-origin"] = origin;
      answerHeaders["access-control-expose-headers"] = "Location";
    }
    return new Response(null, { status: 200, headers: answerHeaders });
  }

  function sessionRequest(url, method, headers, body) {
    const session = sessions.get(url.searchParams.get("upload_id"));
    const cors = { "access-control-allow-origin": session?.origin ?? "null", "access-control-expose-headers": SESSION_EXPOSE };
    if (!session) return new Response(null, { status: 308, headers: cors }); // drive-facts 20
    if (method === "DELETE") {
      session.cancelled = true;
      return new Response(null, { status: 499, headers: cors });
    }
    if (session.cancelled) return new Response(null, { status: 499, headers: cors });
    if (method !== "PUT") return driveError(405, "methodNotAllowed", "Method not allowed.", cors);
    const soFar = () =>
      new Response(null, { status: 308, headers: session.received > 0 ? { ...cors, range: `bytes=0-${session.received - 1}` } : cors });
    const contentRange = headers.get("content-range") ?? "";
    let match = /^bytes \*\/(\d+)$/.exec(contentRange);
    if (match) {
      if (Number(match[1]) !== session.size) return driveError(400, "badContentRange", "Wrong total size.", cors);
      return session.file ? json(200, pick(session.file), cors) : soFar();
    }
    match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange);
    if (!match) return driveError(400, "badContentRange", "Failed to parse Content-Range header.", cors);
    const [a, b, total] = match.slice(1).map(Number);
    const bytes = body ?? Buffer.alloc(0);
    if (total !== session.size || b < a || b >= total || bytes.length !== b - a + 1) {
      return driveError(400, "badContentRange", "Content-Range does not match the bytes.", cors);
    }
    if (session.file) return json(200, pick(session.file), cors);
    if (a > session.received) return driveError(400, "badContentRange", "The bytes do not follow on.", cors);
    const end = b + 1;
    const keepTo = end === total ? end : Math.max(session.received, Math.floor(end / BLOCK) * BLOCK);
    if (keepTo > session.received) {
      session.chunks.push(Buffer.from(bytes.subarray(session.received - a, keepTo - a)));
      session.received = keepTo;
    }
    if (session.received < total) return soFar();
    const all = Buffer.concat(session.chunks);
    session.chunks = [];
    const file = {
      id: session.meta.id ?? newId(),
      name: session.meta.name,
      mimeType: session.mimeType,
      parents: session.meta.parents,
      driveId: session.driveId,
      trashed: false,
      size: String(total),
      md5Checksum: md5Hex(all),
      bytes: all,
    };
    files.set(file.id, file);
    session.file = file;
    return json(200, pick(file), cors);
  }

  function media(file, headers, cors) {
    if (!file.bytes) return driveError(403, "fileNotDownloadable", "Only files with binary content can be downloaded.", cors);
    const range = /^bytes=(\d+)-(\d+)$/.exec(headers.get("range") ?? "");
    if (range) {
      const a = Number(range[1]);
      const b = Math.min(Number(range[2]), file.bytes.length - 1);
      return new Response(file.bytes.subarray(a, b + 1), {
        status: 206,
        headers: { ...cors, "content-type": file.mimeType, "content-range": `bytes ${a}-${b}/${file.bytes.length}` },
      });
    }
    return new Response(file.bytes, { status: 200, headers: { ...cors, "content-type": file.mimeType } });
  }

  function list(url) {
    const params = url.searchParams;
    if (params.get("corpora") === "drive" || params.has("driveId")) {
      return driveError(403, "teamDriveMembershipRequired", "The attempted action requires shared drive membership.");
    }
    if (params.get("supportsAllDrives") !== "true" || params.get("includeItemsFromAllDrives") !== "true") {
      return json(200, { kind: "drive#fileList", files: [] });
    }
    const q = params.get("q") ?? "";
    const parent = /'([^']+)' in parents/.exec(q)?.[1];
    const name = /name = '([^']*)'/.exec(q)?.[1];
    const mimeType = /mimeType = '([^']*)'/.exec(q)?.[1];
    const notTrashed = /trashed = false/.test(q);
    const found = [...files.values()].filter(
      (f) =>
        (!parent || f.parents?.includes(parent)) &&
        (!name || f.name === name) &&
        (!mimeType || f.mimeType === mimeType) &&
        (!notTrashed || !isTrashed(f)),
    );
    return json(200, { kind: "drive#fileList", files: found.map((f) => pick(f)) });
  }

  function create(url, scope, body) {
    if (scope !== WRITE_SCOPE) return driveError(403, "insufficientPermissions", "Insufficient Permission");
    let meta;
    try {
      meta = JSON.parse((body ?? Buffer.alloc(0)).toString("utf8"));
    } catch {
      return driveError(400, "parseError", "Parse Error");
    }
    const parent = findFile(meta.parents?.[0], url);
    if (!parent || parent.mimeType !== FOLDER_MIME || isTrashed(parent)) return driveError(404, "notFound", "File not found.");
    const file = {
      id: newId(),
      name: meta.name,
      mimeType: meta.mimeType ?? MIME,
      parents: [parent.id],
      driveId: parent.driveId,
      trashed: false,
    };
    files.set(file.id, file);
    return json(200, pick(file, url.searchParams.get("fields")));
  }

  async function fetch(input, init = {}) {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers ?? {});
    const body = bodyOf(init.body);
    if (url.origin === "https://oauth2.googleapis.com") {
      if (url.pathname === "/token" && method === "POST") return token(headers, body ?? Buffer.alloc(0));
      return json(404, { error: "not_found" });
    }
    if (url.origin !== API) throw new TypeError(`pretend Google does not answer ${url.origin}`);
    if (method === "OPTIONS") return preflight(headers);
    if (url.pathname === "/upload/drive/v3/files") {
      if (url.searchParams.has("upload_id")) return sessionRequest(url, method, headers, body);
      if (method === "POST" && url.searchParams.get("uploadType") === "resumable") return openUpload(url, headers, body ?? Buffer.alloc(0));
      return driveError(400, "badRequest", "Unsupported upload.");
    }
    const requestOrigin = headers.get("origin");
    const cors = requestOrigin ? { "access-control-allow-origin": requestOrigin } : {};
    const scope = scopeOf(headers);
    if (!scope) return driveError(401, "authError", "Invalid Credentials", cors);
    const path = url.pathname;
    if (path === "/drive/v3/files/generateIds" && method === "GET") {
      const id = newId();
      generated.add(id);
      return json(200, { kind: "drive#generatedIds", space: "drive", ids: [id] });
    }
    if (path === "/drive/v3/files" && method === "GET") return list(url);
    if (path === "/drive/v3/files" && method === "POST") return create(url, scope, body);
    const fileMatch = /^\/drive\/v3\/files\/([^/]+)$/.exec(path);
    if (fileMatch) {
      const file = findFile(decodeURIComponent(fileMatch[1]), url);
      if (!file) return driveError(404, "notFound", "File not found.", cors);
      if (method === "GET") {
        return url.searchParams.get("alt") === "media" ? media(file, headers, cors) : json(200, pick(file, url.searchParams.get("fields")), cors);
      }
      if (method === "PATCH") {
        if (scope !== WRITE_SCOPE) {
          return driveError(403, "insufficientPermissions", "Insufficient Permission: Request had insufficient authentication scopes.", cors);
        }
        let change;
        try {
          change = JSON.parse((body ?? Buffer.alloc(0)).toString("utf8"));
        } catch {
          return driveError(400, "parseError", "Parse Error", cors);
        }
        if (typeof change.trashed === "boolean") file.trashed = change.trashed;
        if (typeof change.name === "string") file.name = change.name;
        return json(200, pick(file), cors);
      }
      if (method === "DELETE") return driveError(404, "notFound", "File not found.", cors); // drive-facts 6
    }
    if (/^\/drive\/v3\/drives\/[^/]+$/.test(path)) return driveError(404, "notFound", "Shared drive not found.");
    return driveError(404, "notFound", "Not found.");
  }

  return {
    fetch,
    files,
    secrets: () => [...tokens.keys(), ...sessionUrls, ...assertions],
  };
}

// ---------------------------------------------------------------------------
// The pretend browser, for --self-test: runs page.html's own script, and
// enforces CORS the way a browser does on its requests to Google (a preflight
// for a non-simple request; an answer whose Access-Control-Allow-Origin does
// not name the page cannot be read; only exposed headers are visible). A PUT
// takes time in proportion to its size, and an abort partway leaves Drive
// holding the whole 256 KiB blocks that arrived.

const SAFELISTED_RESPONSE = new Set(["cache-control", "content-language", "content-length", "content-type", "expires", "last-modified", "pragma"]);
const PRETEND_BYTES_PER_MS = PIECE / 40;

function waitOrAbort(ms, signal) {
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function pretendBrowser({ origin, google }) {
  const refused = () => new TypeError("Failed to fetch");

  async function crossOrigin(url, init) {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers ?? {});
    const nonSimple = [...headers.keys()].filter((name) => !["accept", "accept-language", "content-language"].includes(name)).sort();
    if (!["GET", "HEAD", "POST"].includes(method) || nonSimple.length > 0) {
      const pre = await google.fetch(url.href, {
        method: "OPTIONS",
        headers: { Origin: origin, "Access-Control-Request-Method": method, "Access-Control-Request-Headers": nonSimple.join(",") },
      });
      const allowedHeaders = (pre.headers.get("access-control-allow-headers") ?? "").toLowerCase().split(",").map((h) => h.trim());
      const allowedMethods = (pre.headers.get("access-control-allow-methods") ?? "").toUpperCase().split(",").map((m) => m.trim());
      if (!pre.ok || pre.headers.get("access-control-allow-origin") !== origin) throw refused();
      if (!["GET", "HEAD", "POST"].includes(method) && !allowedMethods.includes(method)) throw refused();
      if (!nonSimple.every((name) => allowedHeaders.includes(name))) throw refused();
    }
    headers.set("Origin", origin);
    const body = bodyOf(init.body);
    const signal = init.signal;
    if (signal?.aborted) throw new DOMException("This operation was aborted", "AbortError");
    if (body && body.length > 0) {
      const ms = Math.max(4, body.length / PRETEND_BYTES_PER_MS);
      const started = performance.now();
      if (await waitOrAbort(ms, signal)) {
        const fraction = Math.min(1, (performance.now() - started) / ms);
        const kept = Math.floor((body.length * fraction) / BLOCK) * BLOCK;
        const range = /^bytes (\d+)-\d+\/(\d+)$/.exec(headers.get("content-range") ?? "");
        if (method === "PUT" && range && kept > 0) {
          const start = Number(range[1]);
          await google.fetch(url.href, {
            method: "PUT",
            headers: { Origin: origin, "Content-Range": `bytes ${start}-${start + kept - 1}/${range[2]}` },
            body: body.subarray(0, kept),
          });
        }
        throw new DOMException("This operation was aborted", "AbortError");
      }
    }
    const res = await google.fetch(url.href, { method, headers, body });
    const allowOrigin = res.headers.get("access-control-allow-origin");
    if (allowOrigin !== origin && allowOrigin !== "*") throw refused();
    const exposed = new Set(
      (res.headers.get("access-control-expose-headers") ?? "").toLowerCase().split(",").map((h) => h.trim()).filter(Boolean),
    );
    const visible = new Headers();
    for (const [name, value] of res.headers) if (SAFELISTED_RESPONSE.has(name) || exposed.has(name)) visible.set(name, value);
    const bytes = await res.arrayBuffer();
    return new Response(bytes.byteLength > 0 ? bytes : null, { status: res.status, headers: visible });
  }

  return async function browserFetch(input, init = {}) {
    const url = new URL(String(input), origin);
    if (url.origin === origin) return globalThis.fetch(url, init);
    return crossOrigin(url, init);
  };
}

async function runPage(origin, browserFetch) {
  const html = await readFile(join(HERE, "page.html"), "utf8");
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!script) throw new Error("page.html has no script");
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        textContent: "",
        disabled: false,
        listeners: {},
        addEventListener(type, listener) {
          this.listeners[type] = listener;
        },
      });
    }
    return elements.get(id);
  };
  const consoleLines = [];
  const pageConsole = {
    log: (...parts) => consoleLines.push(parts.join(" ")),
    warn: (...parts) => consoleLines.push(parts.join(" ")),
    error: (...parts) => consoleLines.push(parts.join(" ")),
  };
  const context = vm.createContext({
    document: { getElementById: element },
    location: { origin, hostname: new URL(origin).hostname },
    fetch: browserFetch,
    AbortController,
    DOMException,
    Uint8Array,
    setTimeout,
    clearTimeout,
    performance,
    console: pageConsole,
  });
  vm.runInContext(script, context, { filename: "page.html" });
  const click = element("run").listeners.click;
  if (!click) throw new Error("the page has no Run check handler");
  await click();
  return { log: element("log").textContent, status: element("status").textContent, console: consoleLines };
}

// ---------------------------------------------------------------------------
// The self-test.

async function selfTest() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const host = new URL(input instanceof Request ? input.url : String(input)).hostname;
    if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) {
      return Promise.reject(new Error(`the self-test refused a request to ${host}`));
    }
    return realFetch(input, init);
  };
  const problems = [];
  const expect = (condition, what) => {
    if (!condition) problems.push(what);
  };
  const tmp = await mkdtemp(join(tmpdir(), "drive-check-"));
  let servers = [];
  try {
    const clientEmail = "drive-check@pretend-project.iam.gserviceaccount.com";
    const rootId = "1PretendMediaFolderId";
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const keyPath = join(tmp, "key.json");
    await writeFile(
      keyPath,
      JSON.stringify({ type: "service_account", client_email: clientEmail, private_key: pair.privateKey.export({ type: "pkcs8", format: "pem" }) }),
    );
    const key = await readKeyFile(keyPath);
    const google = pretendGoogle({ clientEmail, publicKey: pair.publicKey, rootId });

    // The whole check: the server code, with page.html's script as the page.
    let check;
    const listening = await listen((req, res) => check.handle(req, res), 0);
    servers = listening.servers;
    const origin = `http://localhost:${listening.port}`;
    const printed = [];
    check = createCheck({ key, rootId, google: google.fetch, origin, print: (line) => printed.push(line) });
    expect(await check.setup(), "setup (F1 and F2) did not pass");
    const page = await runPage(origin, pretendBrowser({ origin, google }));
    const outcome = await check.done;
    const resultPath = join(tmp, "out", "result.json");
    await writeResult(resultPath, outcome.json);
    const resultText = await readFile(resultPath, "utf8");

    for (const { verdict, line } of check.serverLines()) {
      console.log(line);
      expect(verdict === "PASS", `${line.split(" ")[0]} did not pass`);
    }

    // What the page's script reported, as the pretend browser let it see.
    const facts = outcome.json.facts;
    expect(outcome.ok, `not every required fact passed with the pretend page: ${outcome.lines.filter((l) => / FAIL /.test(l)).join(" | ")}`);
    expect(page.status === "Done. Every required fact passed.", `the page ended on "${page.status}"`);
    expect(facts.F4.pass && facts.F4.status === 308, "F4: the page did not read a 308 for the first piece");
    expect(facts.F5.readable === true && facts.F5.rangeEnd === PIECE - 1, "F5: the page did not read Range bytes=0-8388607");
    expect(facts.F6.thirdPieceAborted === true, "F6: the third piece was not aborted");
    expect(facts.F6.offset > OFFSET_LOW && facts.F6.offset < OFFSET_HIGH, "F6: the abort did not land partway through the third piece");
    expect(facts.F6.idReadable === true && facts.F6.idMatches === true, "F6: the page did not read the preset id from the last answer");
    expect(facts.F8.smallRange206 === true && facts.F8.bigRange206 === true, "F8: a Range read did not answer 206 with the right 1,024 bytes");
    expect(facts.F10.readable === false, "F10: a session opened with no Origin should be unreadable (Allow-Origin: null)");
    expect(typeof facts.F11.mbPerSecond === "number" && facts.F11.mbPerSecond > 0, "F11: no upload speed");
    expect(facts.F12.noOriginTrashed === true, "F12: the no-Origin file was not trashed");
    expect(facts.F2.driveIdIsMediaFolder === false, "F2: the pretend driveId should not be the folder id");

    // Nothing secret printed, shown on the page, or written.
    const everything = [...printed, page.log, page.status, ...page.console, resultText].join("\n");
    const pemLines = key.private_key.split(/\r?\n/).filter((l) => l.length >= 16 && !l.startsWith("-----"));
    const secrets = [...google.secrets(), key.private_key, ...pemLines];
    expect(secrets.length > 5, "the pretend Google recorded no tokens or sessions");
    expect(!secrets.some((secret) => everything.includes(secret)), "a token, a key line or a session address appeared in the output");
    expect(!everything.includes("[hidden]"), "something tried to print a secret and was scrubbed");
    expect(onlyNumbersAndBooleans(JSON.parse(resultText)), "result.json holds more than booleans, status codes and numbers");

    // The calls in lib.mjs, against what Drive was seen to do.
    const write = await tokenFor(key, WRITE_SCOPE, google.fetch);
    const readOnly = await tokenFor(key, READ_SCOPE, google.fetch);
    expect(write.expiresIn === 3599, "tokenFor did not return expires_in");
    const presetId = await generateFileId(write.accessToken, google.fetch);
    const sessionUrl = await openSession(
      write.accessToken,
      { id: presetId, name: "cancel.bin", parentId: rootId, mimeType: MIME, size: 2 * BLOCK, origin },
      google.fetch,
    );
    expect((await askOffset(sessionUrl, 2 * BLOCK, google.fetch)).offset === 0, "a fresh session should be at offset 0");
    await google.fetch(sessionUrl, { method: "PUT", headers: { "Content-Range": `bytes 0-${BLOCK - 1}/${2 * BLOCK}` }, body: patternBytes(BLOCK) });
    expect((await askOffset(sessionUrl, 2 * BLOCK, google.fetch)).offset === BLOCK, "askOffset should answer the byte after Range's last");
    expect((await google.fetch(sessionUrl, { method: "DELETE" })).status === 499, "cancelling a session should answer 499");
    const gone = await askOffset(sessionUrl, 2 * BLOCK, google.fetch).then(() => null, (error) => error);
    expect(gone instanceof GoogleError && gone.status === 499 && gone.reason === "sessionGone", "askOffset should report a cancelled session as gone");
    const refusedFolder = await createFolder(readOnly.accessToken, { name: "x", parentId: rootId }, google.fetch).then(() => null, (e) => e);
    expect(refusedFolder?.status === 403, "a read-only scope should not make a folder");
    const otherPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const wrongKey = { client_email: clientEmail, private_key: otherPair.privateKey.export({ type: "pkcs8", format: "pem" }) };
    const badGrant = await tokenFor(wrongKey, WRITE_SCOPE, google.fetch).then(() => null, (e) => e);
    expect(badGrant?.status === 400 && badGrant.reason === "invalid_grant" && !badGrant.message.includes("PRIVATE"), "a wrong key should fail with invalid_grant only");
    const auth = { Authorization: `Bearer ${write.accessToken}` };
    const q = encodeURIComponent(`'${rootId}' in parents and trashed = false`);
    const noFlags = await (await google.fetch(`${API}/drive/v3/files?q=${q}`, { headers: auth })).json();
    const withFlags = await (await google.fetch(`${API}/drive/v3/files?q=${q}&supportsAllDrives=true&includeItemsFromAllDrives=true`, { headers: auth })).json();
    const byDrive = await google.fetch(`${API}/drive/v3/files?corpora=drive&driveId=${PRETEND_DRIVE_ID}&supportsAllDrives=true&includeItemsFromAllDrives=true`, { headers: auth });
    expect(noFlags.files.length === 0, "a list without the AllDrives flags should find nothing");
    expect(Array.isArray(withFlags.files), "a list with both flags should answer");
    expect(byDrive.status === 403, "a list by drive should be refused");
    const deleted = await google.fetch(`${API}/drive/v3/files/${rootId}?supportsAllDrives=true`, { method: "DELETE", headers: auth });
    expect(deleted.status === 404, "deleting for good should answer 404");

    // Each verdict fails when it should.
    const good = cleanPage({
      firstPiece: { readable: true, status: 308, rangeReadable: true, rangeEnd: PIECE - 1 },
      thirdPieceAborted: true,
      resumedFrom: 20971520,
      lastStatus: 200,
      idReadable: true,
      idMatches: true,
      small: { uploaded: true, wholeStatus: 200, wholeMatch: true, rangeStatus: 206, rangeMatch: true },
    });
    const folder = { id: "folder", driveId: "drive" };
    const goodFile = { id: "big", size: String(BIG), md5Checksum: "m", parents: ["folder"], driveId: "drive" };
    expect(judge.F6(20971520, good).verdict === "PASS", "judge.F6 should pass a good run");
    expect(judge.F6(OFFSET_LOW - 1, { ...good, resumedFrom: OFFSET_LOW - 1 }).verdict === "FAIL", "judge.F6 should fail an offset below the third piece");
    expect(judge.F6(OFFSET_HIGH + 1, { ...good, resumedFrom: OFFSET_HIGH + 1 }).verdict === "FAIL", "judge.F6 should fail an offset past the third piece");
    expect(judge.F6(20971520, { ...good, resumedFrom: 0 }).verdict === "FAIL", "judge.F6 should fail when the page did not go on from the offset");
    expect(judge.F6(20971520, { ...good, lastStatus: 308 }).verdict === "FAIL", "judge.F6 should fail when the last PUT was not 200 or 201");
    expect(judge.F6(null, good).verdict === "FAIL", "judge.F6 should fail with no offset");
    expect(judge.F4(good).verdict === "PASS", "judge.F4 should pass a readable 308");
    expect(judge.F4({ ...good, firstPiece: { ...good.firstPiece, readable: false, status: null } }).verdict === "FAIL", "judge.F4 should fail an unreadable answer");
    expect(judge.F4({ ...good, firstPiece: { ...good.firstPiece, status: 200 } }).verdict === "FAIL", "judge.F4 should fail a status other than 308");
    expect(judge.F7(goodFile, folder, "m").verdict === "PASS", "judge.F7 should pass a good file");
    expect(judge.F7({ ...goodFile, md5Checksum: "x" }, folder, "m").verdict === "FAIL", "judge.F7 should fail a wrong md5");
    expect(judge.F7({ ...goodFile, size: "1" }, folder, "m").verdict === "FAIL", "judge.F7 should fail a wrong size");
    expect(judge.F7({ ...goodFile, parents: ["other"] }, folder, "m").verdict === "FAIL", "judge.F7 should fail a wrong parent");
    expect(judge.F7({ ...goodFile, driveId: "folder" }, folder, "m").verdict === "FAIL", "judge.F7 should fail a different driveId");
    expect(judge.F7(null, folder, "m", "files.get answered 404").verdict === "FAIL", "judge.F7 should fail a missing file");
    expect(judge.F3("big", { id: "other" }).verdict === "FAIL", "judge.F3 should fail a different id");
    expect(judge.F3(null, null).verdict === "FAIL", "judge.F3 should fail with no session");
    expect(judge.F8({ ...good, small: { ...good.small, wholeMatch: false } }).verdict === "FAIL", "judge.F8 should fail bytes that do not match");
    expect(judge.F9({ status: 200 }).verdict === "FAIL", "judge.F9 should fail a trash the read-only scope was allowed");
    expect(judge.F9({ status: 403 }).verdict === "PASS", "judge.F9 should pass a 403");
    expect(judge.F2({ parents: ["other"], driveId: "d" }, rootId).verdict === "FAIL", "judge.F2 should fail a folder made elsewhere");
    const trashedItems = [
      { key: "folder", name: "folder", trashed: true },
      { key: "big", name: "64 MiB file", trashed: true },
      { key: "small", name: "1 MiB file", trashed: true },
    ];
    expect(judge.F12(trashedItems).verdict === "PASS", "judge.F12 should pass when all are trashed");
    expect(judge.F12([...trashedItems.slice(0, 2), { ...trashedItems[2], trashed: false }]).verdict === "FAIL", "judge.F12 should fail a file left out of the trash");
    expect(judge.F12([{ ...trashedItems[0], trashed: null }, ...trashedItems.slice(1)]).verdict === "FAIL", "judge.F12 should fail a missing folder");
    expect(judge.F5(good).verdict === "RECORDED" && judge.F10(good).verdict === "RECORDED", "F5 and F10 should be recorded, not judged");
  } finally {
    closeAll(servers);
    await rm(tmp, { recursive: true, force: true });
    globalThis.fetch = realFetch;
  }
  if (problems.length > 0) {
    for (const problem of problems) console.log(`self-test problem: ${problem}`);
    return 1;
  }
  console.log("self-test ok");
  return 0;
}

// ---------------------------------------------------------------------------

let code;
try {
  code = process.argv.includes("--self-test") ? await selfTest() : await main();
} catch (error) {
  console.error(`The drive check stopped: ${error instanceof Error ? error.message : String(error)}`);
  code = 1;
}
process.exit(code);
