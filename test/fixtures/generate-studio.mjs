import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const checkout = process.argv[2];
if (!checkout) throw new Error("Usage: node test/fixtures/generate-studio.mjs <Studio checkout>");
const revision = "880a77b9c5ae047c5a5a8155250f507ef31f5a73";
const git = (...args) => execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" });
const files = new Set(git("ls-tree", "-r", "--name-only", revision).trim().split("\n"));
const output = await build({
  entryPoints: ["packages/export-pipeline/src/scorm/api/xapi.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  plugins: [{ name: "studio-revision", setup(build) {
    build.onResolve({ filter: /.*/ }, ({ path: request, importer }) => {
      const base = request.startsWith("@praxity/")
        ? request.replace(/^@praxity\/([^/]+)\//, "packages/$1/src/")
        : importer ? path.posix.join(path.posix.dirname(importer), request) : request;
      const found = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find(file => files.has(file));
      if (!found) throw new Error(`Cannot resolve ${request} from ${importer}`);
      return { path: found, namespace: "studio" };
    });
    build.onLoad({ filter: /.*/, namespace: "studio" }, ({ path: file }) => ({
      contents: git("show", `${revision}:${file}`), loader: file.endsWith(".tsx") ? "tsx" : "ts",
    }));
  } }],
});
const { XapiRuntime } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`);
const statements = [];
const runtime = new XapiRuntime({
  endpoint: "https://proof.test/xapi/statements",
  auth: "Basic fixture",
  actor: { name: "Studio Learner", mbox: "mailto:studio@example.org" },
  actorMode: "manual",
}, undefined, undefined, "https://example.org/studio-course");
runtime.sendStatement = async statement => { statements.push(statement); };
runtime.initialize();
runtime.trackPageVisit("intro");
runtime.trackNavigation("intro", "practice", "next");
runtime.trackInteraction("choice-1", "B", true, 1);
runtime.trackInteraction("reflection", "My response");
runtime.setScore(1, 0, 1);
runtime.setCompletion("completed");
for (const [i, statement] of statements.entries()) {
  statement.id = `880a77b9-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;
  statement.timestamp = `2026-11-22T10:0${i}:00.000Z`;
}
writeFileSync(new URL("./studio-session.json", import.meta.url), JSON.stringify(statements, null, 2) + "\n");
