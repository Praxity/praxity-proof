import { env, SELF } from "cloudflare:test";
import { expect, it } from "vitest";
import { mintKey } from "../src/auth";
import { D1Storage } from "../src/storage/d1";
import session from "./fixtures/studio-session.json";
import { ADMIN } from "./helpers";

async function ingestSession(mode: "named" | "anonymous" = "named", completed = true, iri = `https://example.org/studio-${crypto.randomUUID()}`) {
  const key = await mintKey(env.DB, "Studio contract", "ingest", { activityScope: iri, identityMode: mode });
  const batch = (completed ? session : session.slice(0, -1)).map(statement => ({
    ...statement,
    id: crypto.randomUUID(),
    object: {
      ...statement.object,
      id: statement.object.id.replace("https://example.org/studio-course", iri),
      definition: statement.object.id.endsWith("/interaction/choice-1")
        ? { ...statement.object.definition, description: { "en-US": "Which option is correct?" } }
        : statement.object.definition,
    },
  }));
  const response = await SELF.fetch("https://proof.test/xapi/statements", {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${key.id}:${key.secret}`)}`,
      "Content-Type": "application/json",
      "X-Experience-API-Version": "1.0.3",
    },
    body: JSON.stringify(batch),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toHaveLength(batch.length);
  return { iri, batch, storage: new D1Storage(env.DB) };
}

it("reports Studio answers, correctness and course scores without listing child activities", async () => {
  const { iri, storage, batch } = await ingestSession();
  expect((await storage.listActivities()).filter(row => row.iri.startsWith(iri)).map(row => row.iri)).toEqual([iri]);
  expect(await storage.answers(iri)).toMatchObject([
    { questionId: "choice-1", questionLabel: "Which option is correct?", response: "B", success: 1 },
    { questionId: "reflection", response: "My response", success: null },
  ]);
  expect(await storage.questionStats(iri)).toMatchObject([
    { questionId: "choice-1", questionLabel: "Which option is correct?", answered: 1, correct: 1, knownCorrectness: 1 },
    { questionId: "reflection", answered: 1, correct: 0, knownCorrectness: 0 },
  ]);
  expect(await storage.getStatement(batch[3].id)).toMatchObject({ scoreRaw: 1, response: "B", success: 1 });
  expect(await storage.getActivityStats(iri)).toMatchObject({ starts: 1, participants: 1, completions: 1, avgScoreScaled: 1 });
  const report = await SELF.fetch(`https://proof.test/api/activity?iri=${encodeURIComponent(iri)}`, { headers: ADMIN });
  expect(report.status).toBe(200);
  const body = await report.json() as { learners: { responses: unknown[] }[] };
  expect(body.learners[0].responses).toMatchObject([
    { question: "choice-1", label: "Which option is correct?", response: "B", correct: true },
    { question: "reflection", response: "My response", correct: null },
  ]);
});

it.each([false, true])("reports Studio page visits and navigation with historical=%s", async historical => {
  const { iri, storage, batch } = await ingestSession("named", false);
  if (historical) {
    await env.DB.prepare("UPDATE statements SET step = NULL WHERE substr(activity_iri, 1, ?) = ?").bind(iri.length + 1, `${iri}/`).run();
  } else {
    expect(await storage.getStatement(batch[1].id)).toMatchObject({ step: "intro" });
    expect(await storage.getStatement(batch[2].id)).toMatchObject({ step: "practice" });
  }
  expect(await storage.stepFunnel(iri)).toMatchObject([
    { step: "intro", learners: 1, dropOff: 0 },
    { step: "practice", learners: 1, dropOff: 1 },
  ]);
  expect(await storage.participantDropOff(iri)).toBe(0);
  const roster = await storage.listRoster(iri);
  const timeline = await storage.learnerTimeline(iri, roster[0].learnerId);
  expect(timeline.filter(row => row.step !== null).map(row => row.step)).toEqual(["intro", "practice"]);
  expect(await storage.stepLabels(iri)).toEqual({ intro: "intro", practice: "practice" });
  const raw = JSON.parse((await storage.getStatement(batch[2].id))!.raw);
  expect(raw.context.extensions).toEqual({
    "https://praxity.io/xapi/from": "intro",
    "https://praxity.io/xapi/trigger": "next",
  });
});

it("reports anonymous Studio visits while keeping the existing metadata filter", async () => {
  const { iri, storage, batch } = await ingestSession("anonymous");
  expect(await storage.stepFunnel(iri)).toHaveLength(2);
  expect(await storage.answers(iri)).toHaveLength(2);
  const raw = JSON.parse((await storage.getStatement(batch[2].id))!.raw);
  expect(raw.actor.name).toBeUndefined();
  expect(raw.context).toBeUndefined();
});

it("applies the anonymous course policy to Studio children sent with an unscoped named key", async () => {
  const iri = `https://example.org/studio-private-${crypto.randomUUID()}`;
  await mintKey(env.DB, "Anonymous course", "ingest", { activityScope: iri, identityMode: "anonymous" });
  const key = await mintKey(env.DB, "Unscoped named producer", "ingest", { identityMode: "named" });
  const batch = session.slice(0, 5).map(statement => ({
    ...statement,
    id: crypto.randomUUID(),
    object: { ...statement.object, id: statement.object.id.replace("https://example.org/studio-course", iri) },
  }));
  const response = await SELF.fetch("https://proof.test/xapi/statements", {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${key.id}:${key.secret}`)}`,
      "Content-Type": "application/json",
      "X-Experience-API-Version": "1.0.3",
    },
    body: JSON.stringify(batch),
  });
  expect(response.status).toBe(200);
  const storage = new D1Storage(env.DB);
  for (const statement of batch) {
    const stored = await storage.getStatement(statement.id);
    const raw = JSON.parse(stored!.raw);
    expect(raw.actor.name).toBeUndefined();
    expect(raw.actor.mbox).toBeUndefined();
    expect(raw.actor.account.homePage).toBe("https://praxity.io/proof/anonymous");
    expect(raw.context).toBeUndefined();
    expect(await env.DB.prepare("SELECT policy_iri, identity_mode FROM statements WHERE id = ?")
      .bind(statement.id).first()).toEqual({ policy_iri: iri, identity_mode: "anonymous" });
  }
  const roster = await storage.listRoster(iri);
  expect(roster).toHaveLength(1);
  expect(await storage.getLearner(roster[0].learnerId)).toMatchObject({ identity: expect.stringMatching(/^anonymous:/) });
  expect(await storage.answers(iri)).toHaveLength(2);
  expect(await storage.questionStats(iri)).toHaveLength(2);
  const report = await SELF.fetch(`https://proof.test/api/activity?iri=${encodeURIComponent(iri)}`, { headers: ADMIN });
  expect(report.status).toBe(200);
  const text = await report.text();
  expect(text).not.toContain("Studio Learner");
  expect(text).not.toContain("studio@example.org");
  const body = JSON.parse(text);
  expect(body.learners).toHaveLength(1);
  expect(body.learners[0]).toMatchObject({ anonymous: true });
  expect(body.learners[0].responses).toHaveLength(2);
});

it("uses the scoped course root when a Studio course IRI contains /page/", async () => {
  const iri = `https://example.org/page/catalog/studio-${crypto.randomUUID()}`;
  const { storage, batch } = await ingestSession("named", true, iri);
  expect(await storage.getStatement(batch[1].id)).toMatchObject({ step: "intro" });
  expect(await storage.getStatement(batch[2].id)).toMatchObject({ step: "practice" });
  expect((await storage.stepFunnel(iri)).map(row => row.step)).toEqual(["intro", "practice"]);
});
