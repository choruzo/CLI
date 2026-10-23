import { describe, expect, it } from "vitest";
import { parseSkills } from "./results";

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
