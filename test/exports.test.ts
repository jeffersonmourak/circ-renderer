// What the package lets a host import, and from where.
//
// `circ-renderer/topology` exists so a host can name a `ComponentKind` in a
// bundle that must not carry the canvas: the playground's eager script joins
// declarations to boxes by kind byte, and used to hard-code `0`, `8` and `9`
// rather than pay for the renderer at page load. The subpath only earns that
// if the module behind it stays self-contained.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  exports: Record<string, string>;
  main: string;
};

describe("package exports", () => {
  test("the root and the topology subpath point at files that exist", () => {
    expect(pkg.exports["."]).toBe("./" + pkg.main);
    expect(pkg.exports["./topology"]).toBe("./src/wasm/topology.ts");
    for (const target of Object.values(pkg.exports)) expect(existsSync(join(ROOT, target))).toBe(true);
  });

  test("the topology module imports nothing, so the subpath drags nothing in", () => {
    const source = readFileSync(join(ROOT, pkg.exports["./topology"]), "utf8");
    expect(source.match(/^import\b/gm) ?? []).toEqual([]);
    expect(source).not.toMatch(/\bdocument\b|\bwindow\b|HTMLCanvasElement/);
  });

  test("the subpath resolves by the package's own name and is the same module the root re-exports", async () => {
    const sub = await import("circ-renderer/topology");
    const root = await import("circ-renderer");
    expect(sub.ComponentKind).toBe(root.ComponentKind);
    expect(sub.ComponentKind.InputPin).toBe(0);
    expect(sub.ComponentKind.Rom).toBe(8);
    expect(sub.ComponentKind.Ram).toBe(9);
    expect(typeof sub.decodeFullTopology).toBe("function");
  });
});
