// Team membership decides who sees a private team's bounties, and both the
// bounty feed and single bounties are cached per viewer under the "bounties"
// version. Adding or removing a member must bump that version, as favoriting
// a team already does, so a removed member stops seeing the private bounties
// at once and a new member sees them at once.
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const stub = (relative, exports) => {
  const file = require.resolve(path.join("..", relative));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};

let members;
const bumps = [];

const known = {
  user: {
    findMany: async ({ where }) => where.id.in.map((id) => ({ id, role: "TEAM" })),
  },
  teamMember: {
    findUnique: async ({ where }) =>
      members.find((m) => m.userId === where.teamId_userId.userId) ?? null,
    upsert: async ({ create }) => {
      members.push(create);
      return { ...create, user: { id: create.userId } };
    },
    delete: async ({ where }) => {
      members = members.filter((m) => m.userId !== where.teamId_userId.userId);
      return {};
    },
  },
  teamWallet: { findUnique: async () => null },
};
// Every other model call succeeds with no rows.
const model = (name) =>
  new Proxy(known[name] ?? {}, {
    get: (target, op) =>
      target[op] ?? (async () => (/^find(Unique|First)/.test(op) ? null : [])),
  });
const fakePrisma = new Proxy({}, {
  get: (_, name) =>
    name === "$transaction"
      ? async (arg) => (typeof arg === "function" ? arg(fakePrisma) : Promise.all(arg))
      : model(name),
});

{
  const file = require.resolve("@prisma/client");
  require.cache[file] = {
    id: file, filename: file, loaded: true,
    exports: { PrismaClient: function () { return fakePrisma; } },
  };
}
stub("prisma/client.js", fakePrisma);
stub("middleware/auth.js", {
  authenticate: (req, res, next) => {
    req.user = { id: "admin1", role: "ADMIN" };
    next();
  },
  optionalAuthenticate: (req, res, next) => next(),
  isAdmin: (req, res, next) => next(),
});
stub("middleware/websocket.js", {
  sendRealtimeUpdate: () => {},
  sendToUser: () => {},
});
stub("utils/cache.js", {
  delCache: async () => {},
  deleteCacheByPattern: async () => {},
  getCache: async () => null,
  setCache: async () => {},
  getVersion: async () => 1,
  bumpVersion: async (name) => { bumps.push(name); },
  TTL: {},
});
{
  const file = require.resolve("web-push");
  require.cache[file] = {
    id: file, filename: file, loaded: true,
    exports: { setVapidDetails() {}, sendNotification: async () => {}, generateVAPIDKeys: () => ({}) },
  };
}

const express = require("express");
const router = require("../routes/teams");

let server;
let baseUrl;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/teams", router);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  console.error = () => {};
});

after(() => server.close());

beforeEach(() => {
  members = [{ teamId: "team1", userId: "owner", role: "OWNER" }, { teamId: "team1", userId: "leaver", role: "MEMBER" }];
  bumps.length = 0;
});

const call = async (method, url, body) => {
  const res = await fetch(`${baseUrl}/api/teams${url}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.status;
};

describe("team membership refreshes the cached bounty views", () => {
  it("adding a member bumps the bounties version", async () => {
    assert.equal(await call("POST", "/team1/members", { userIds: ["joiner"] }), 201);
    assert.ok(bumps.includes("bounties"), `bumped: ${JSON.stringify(bumps)}`);
  });

  it("removing a member bumps the bounties version", async () => {
    assert.equal(await call("DELETE", "/team1/members/leaver"), 200);
    assert.ok(bumps.includes("bounties"), `bumped: ${JSON.stringify(bumps)}`);
  });
});
