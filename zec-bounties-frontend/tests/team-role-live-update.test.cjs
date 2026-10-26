const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

// When a team OWNER changes someone's role, the server broadcasts
// team_member_role_updated to the team. Every open session must apply it, so
// a promoted admin gets the controls and a demoted one loses them without a
// reload. Runs the real BountyProvider and its websocket handler with React
// hooks and WebSocket replaced; no DOM.
function loadTs(relative, requireFixture, globals = {}) {
  const filename = path.resolve(__dirname, "..", relative);
  const out = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(out, { module, exports: module.exports, require: requireFixture, process, console, ...globals }, { filename });
  return module.exports;
}

function hooks() {
  const state = [];
  const effects = [];
  let cursor = 0;
  return {
    state,
    effects,
    reset() { cursor = 0; effects.length = 0; },
    react: {
      createContext: () => ({ Provider: "Provider" }),
      useContext: () => undefined,
      useState(initial) {
        const i = cursor++;
        if (!(i in state)) state[i] = typeof initial === "function" ? initial() : initial;
        return [state[i], (v) => { state[i] = typeof v === "function" ? v(state[i]) : v; }];
      },
      useEffect(fn) { effects.push(fn); },
      useMemo: (fn) => fn(),
      useRef: (value) => ({ current: value }),
    },
  };
}

const jsxRuntime = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: "Fragment" };

function provider() {
  const h = hooks();
  const sockets = [];
  class FakeWebSocket { constructor(url) { this.url = url; sockets.push(this); } close() {} send() {} }
  const fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  const local = (relative) => loadTs(relative, (id) => {
    if (id === "./configENV") return { backendUrl: "http://api.test", backendWebSpocketUrl: "ws://api.test" };
    throw new Error(`Unexpected dependency: ${id}`);
  });
  const { BountyProvider } = loadTs("lib/bounty-context.tsx", (id) => {
    if (id === "react") return h.react;
    if (id === "react/jsx-runtime") return jsxRuntime;
    if (id === "./configENV") return { backendUrl: "http://api.test", backendWebSpocketUrl: "ws://api.test" };
    if (id === "./displayName") return local("lib/displayName.ts");
    if (id === "./bounty-merge") return local("lib/bounty-merge.ts");
    if (id === "./types") return {};
    throw new Error(`Unexpected dependency: ${id}`);
  }, { fetch, WebSocket: FakeWebSocket, localStorage: { getItem: () => "token", setItem() {}, removeItem() {} }, setTimeout, clearTimeout, URLSearchParams, Promise, Date, JSON });
  const render = () => { h.reset(); return BountyProvider({ children: null }).props.value; };
  render();
  h.state[1] = { id: "bob", name: "Bob", role: "TEAM" }; // currentUser (second useState)
  render();
  // Run only the effect that opens the socket.
  h.effects.filter((fn) => String(fn).includes("new WebSocket")).forEach((fn) => fn());
  assert.equal(sockets.length, 1, "the provider opened its websocket");
  const receive = (type, payload) => sockets[0].onmessage({ data: JSON.stringify({ type, payload }) });
  return { render, receive };
}

test("a role change broadcast to the team updates that member in every open session", () => {
  const { render, receive } = provider();
  receive("team_created", {
    id: "t1",
    name: "Team",
    members: [
      { userId: "owner", role: "OWNER", user: { id: "owner", name: "Owner" } },
      { userId: "bob", role: "MEMBER", user: { id: "bob", name: "Bob", email: "bob@example.test" } },
    ],
  });
  receive("team_member_role_updated", {
    teamId: "t1",
    member: { userId: "bob", teamId: "t1", role: "ADMIN", user: { id: "bob", name: "Bob" } },
  });
  const team = render().teams.find((t) => t.id === "t1");
  assert.deepEqual(team.members.map((m) => [m.userId, m.role]), [["owner", "OWNER"], ["bob", "ADMIN"]]);
  // The broadcast carries public fields only; details we already had stay.
  assert.equal(team.members[1].user.email, "bob@example.test");
});

test("a role change for another team leaves this team alone", () => {
  const { render, receive } = provider();
  receive("team_created", { id: "t1", name: "Team", members: [{ userId: "bob", role: "MEMBER", user: { id: "bob" } }] });
  receive("team_member_role_updated", { teamId: "t2", member: { userId: "bob", teamId: "t2", role: "ADMIN" } });
  assert.equal(render().teams[0].members[0].role, "MEMBER");
});
