import { describe, expect, it } from "vitest";
import { parseAgents, parseBrowserView, parseChanges, parseDiff, parseRevert, parseSkills } from "./results";

describe("parseSkills", () => {
  it("acepta el resultado de skills.list", () => {
    const skills = [
      {
        name: "resumir",
        description: "Resume textos",
        scope: "builtin",
        presets: ["assistant"],
      },
      {
        name: "revisar",
        description: "Revisa código",
        scope: "project",
        presets: ["coding", "assistant"],
      },
    ];
    expect(parseSkills({ skills })).toEqual(skills);
    expect(parseSkills({ skills: [] })).toEqual([]);
  });

  it("un resultado que no valida no se usa", () => {
    expect(parseSkills({})).toBeNull();
    expect(parseSkills(null)).toBeNull();
    expect(
      parseSkills({
        skills: [{ name: "x", description: "y", scope: "otro", presets: [] }],
      }),
    ).toBeNull();
  });
});

describe("modo código", () => {
  it("parseChanges: el resumen del working tree", () => {
    const changes = {
      isRepo: true,
      files: 2,
      added: 4,
      deleted: 1,
      changes: [
        { path: "src/a.ts", added: 4, deleted: 1, status: "modified" },
        { path: "logo.png", added: 0, deleted: 0, status: "untracked", binary: true },
      ],
      truncated: false,
    };
    expect(parseChanges({ changes })).toEqual(changes);
    expect(parseChanges({ changes: { ...changes, isRepo: "sí" } })).toBeNull();
    expect(parseChanges({})).toBeNull();
  });

  it("parseDiff: el diff de un fichero", () => {
    const diff = { diff: "+x\n", truncated: false, binary: false };
    expect(parseDiff(diff)).toEqual(diff);
    expect(parseDiff({ diff: "+x\n" })).toBeNull();
  });

  it("parseBrowserView: estado del navegador y su captura", () => {
    const open = {
      browser: { state: "open", url: "http://localhost:3000/", title: "App", loading: false, canGoBack: true },
      screen: { mime: "image/jpeg", data: "/9j/AAA=", width: 1280, height: 800, takenAt: 1 },
    };
    expect(parseBrowserView(open)).toEqual(open);
    expect(parseBrowserView({ browser: { state: "closed" }, screen: null })).toEqual({
      browser: { state: "closed" },
      screen: null,
    });
    expect(parseBrowserView({ browser: { state: "unavailable", reason: "peer-hosted" }, screen: null })).toEqual({
      browser: { state: "unavailable", reason: "peer-hosted" },
      screen: null,
    });
    // Otra cosa que JPEG, un estado que no es del contrato, o sin `screen`: no se usa.
    expect(parseBrowserView({ ...open, screen: { ...open.screen, mime: "image/png" } })).toBeNull();
    expect(parseBrowserView({ browser: { state: "running" }, screen: null })).toBeNull();
    expect(parseBrowserView({ browser: { state: "closed" } })).toBeNull();
  });

  it("parseRevert: el plan o lo que se hizo", () => {
    const plan = { turns: [3], restore: ["a.txt"], remove: [], conflicts: [], skipped: [], truncated: false };
    expect(parseRevert({ status: "planned", plan })).toEqual({ status: "planned", plan });
    expect(parseRevert({ status: "nothing", plan: null })).toEqual({ status: "nothing", plan: null });
    expect(parseRevert({ status: "otro", plan: null })).toBeNull();
  });

  it("parseAgents: los perfiles que se pueden elegir", () => {
    const agents = [
      { name: "assistant", description: "Asistente", mode: "primary", origin: "builtin", allowedTools: null },
    ];
    expect(parseAgents({ agents })).toEqual(agents);
    expect(parseAgents({ agents: [{ name: "x" }] })).toBeNull();
  });
});
