import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeBridge } from "../../ipc/native";
import { SessionContextPanel } from "./SessionContextPanel";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

afterEach(cleanup);

function bridge(listSkills: () => Promise<unknown>): NativeBridge {
  return {
    context: vi.fn(async () => ({})),
    memory: vi.fn(async () => ({})),
    listSkills: vi.fn(listSkills),
  } as unknown as NativeBridge;
}

const mount = (native: NativeBridge) =>
  render(
    <SessionContextPanel native={native} sessionId="ses_1" refreshKey="k" />,
  );

describe("SessionContextPanel: skills", () => {
  it("lista el nombre y la descripción de cada skill", async () => {
    mount(
      bridge(async () => ({
        skills: [
          {
            name: "resumir",
            description: "Resume textos",
            scope: "builtin",
            presets: ["assistant"],
          },
          {
            name: "revisar",
            description: "Revisa código",
            scope: "user",
            presets: ["coding"],
          },
        ],
      })),
    );
    await waitFor(() => expect(screen.getByText("resumir")).toBeTruthy());
    expect(screen.getByText(/Resume textos/)).toBeTruthy();
    expect(screen.getByText("revisar")).toBeTruthy();
    expect(screen.getByText(/Revisa código/)).toBeTruthy();
  });

  it("sin skills dice que no hay", async () => {
    mount(bridge(async () => ({ skills: [] })));
    await waitFor(() =>
      expect(screen.getByText("Sin skills disponibles.")).toBeTruthy(),
    );
  });

  it("si no se pueden leer, avisa sin romper el panel", async () => {
    mount(
      bridge(async () => {
        throw new Error("caído");
      }),
    );
    await waitFor(() =>
      expect(screen.getByText(/No se pudieron leer las skills/)).toBeTruthy(),
    );
    expect(screen.getByText("Contexto")).toBeTruthy();
  });
});
